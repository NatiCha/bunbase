import type { ServerWebSocket } from "bun";
import type { Column, SQL, Table } from "drizzle-orm";
import { and, eq, getColumns, getTableName } from "drizzle-orm";
import type { AnyDb } from "../core/db-types.ts";
import { type FieldPolicyMap, resolveFieldPolicy, stripHidden } from "../core/field-policy.ts";
import { evaluateRule } from "../rules/evaluator.ts";
import type { TableRules } from "../rules/types.ts";
import type { PresenceTracker } from "./presence.ts";
import {
  type ChannelContext,
  channelTopic,
  type RealtimeOptions,
  realtimeLimits,
} from "./security.ts";
import type { RealtimeSocketData, ServerMessage } from "./types.ts";

/**
 * Realtime subscription state and filtered table change broadcasting.
 * @module
 */

export type BroadcastFn = (
  tableName: string,
  action: "INSERT" | "UPDATE" | "DELETE",
  record: Record<string, unknown>,
) => void;

interface Subscriber {
  ws: ServerWebSocket<RealtimeSocketData>;
  filtered: boolean;
  whereClause?: SQL;
  visibleIds: Set<string>;
}

export class RealtimeManager {
  private sockets = new Set<ServerWebSocket<RealtimeSocketData>>();
  private closed = new WeakSet<ServerWebSocket<RealtimeSocketData>>();

  track(ws: ServerWebSocket<RealtimeSocketData>): void {
    this.sockets.add(ws);
  }

  async refreshAuth(ws: ServerWebSocket<RealtimeSocketData>): Promise<boolean> {
    if (this.closed.has(ws)) return false;
    this.track(ws);
    if (!ws.data.authenticate) return true;
    try {
      const previous = ws.data.auth;
      const current = await ws.data.authenticate();
      if (this.closed.has(ws)) return false;
      if (previous && (!current || previous.id !== current.id)) {
        this.removeAllSubscriptions(ws);
        ws.close(1008, "Authentication expired or revoked");
        return false;
      }
      ws.data.auth = current;
      return true;
    } catch {
      this.removeAllSubscriptions(ws);
      ws.close(1011, "Authentication check failed");
      return false;
    }
  }

  readonly limits;
  private channels = new Map<
    ServerWebSocket<RealtimeSocketData>,
    Map<string, { kind: "broadcast" | "presence"; channel: string }>
  >();
  private queues = new WeakMap<
    ServerWebSocket<RealtimeSocketData>,
    { tail: Promise<void>; pending: number; count: number; start: number }
  >();
  private connections = new Map<string, number>();

  reserveConnection(ip: string, userId?: string): (() => void) | null {
    const keys: [string, number][] = [[`ip:${ip}`, this.limits.maxConnectionsPerIp]];
    if (userId) keys.push([`user:${userId}`, this.limits.maxConnectionsPerUser]);
    if (keys.some(([key, max]) => (this.connections.get(key) ?? 0) >= max)) return null;
    for (const [key] of keys) this.connections.set(key, (this.connections.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const [key] of keys) {
        const count = (this.connections.get(key) ?? 1) - 1;
        if (count) this.connections.set(key, count);
        else this.connections.delete(key);
      }
    };
  }

  /** Admission is synchronous; queued operations serialize subscription decisions. */
  enqueue(ws: ServerWebSocket<RealtimeSocketData>, work: () => Promise<void>): Promise<void> {
    if (this.closed.has(ws)) return Promise.resolve();
    let queue = this.queues.get(ws);
    if (!queue) {
      queue = { tail: Promise.resolve(), pending: 0, count: 0, start: Date.now() };
      this.queues.set(ws, queue);
    }
    if (Date.now() - queue.start >= this.limits.windowMs) {
      queue.start = Date.now();
      queue.count = 0;
    }
    if (
      ++queue.count > this.limits.messagesPerWindow ||
      queue.pending >= this.limits.maxPendingMessages
    ) {
      this.removeAllSubscriptions(ws);
      ws.close(1008, "Realtime rate limit exceeded");
      return Promise.resolve();
    }
    queue.pending++;
    const state = queue;
    state.tail = state.tail
      .then(async () => {
        if (!this.closed.has(ws)) await work();
      })
      .catch(() => {
        this.sendTo(ws, { type: "error", message: "Realtime operation failed" });
      })
      .finally(() => {
        state.pending--;
      });
    return state.tail;
  }

  subscriptionCount(ws: ServerWebSocket<RealtimeSocketData>): number {
    let count = this.channels.get(ws)?.size ?? 0;
    for (const subs of this.tableSubscribers.values())
      for (const sub of subs) if (sub.ws === ws) count++;
    return count;
  }
  async authorizeChannel(
    ws: ServerWebSocket<RealtimeSocketData>,
    kind: "broadcast" | "presence",
    channel: string,
    action: ChannelContext["action"],
  ): Promise<boolean> {
    if (!(await this.refreshAuth(ws)) || !ws.data.auth || !this.options.authorize) return false;
    try {
      return (
        (await this.options.authorize({
          auth: ws.data.auth,
          db: this.db,
          kind,
          channel,
          action,
        })) === true && !this.closed.has(ws)
      );
    } catch {
      return false;
    }
  }
  async subscribeChannel(
    ws: ServerWebSocket<RealtimeSocketData>,
    kind: "broadcast" | "presence",
    channel: string,
  ): Promise<boolean> {
    const topic = channelTopic(kind, channel);
    if (!(await this.authorizeChannel(ws, kind, channel, "subscribe"))) {
      this.sendTo(ws, { type: "error", message: "Channel access denied" });
      return false;
    }
    if (this.channels.get(ws)?.has(topic)) return true;
    if (this.subscriptionCount(ws) >= this.limits.maxSubscriptions) {
      this.sendTo(ws, { type: "error", message: "Subscription limit exceeded" });
      return false;
    }
    if (!this.channels.has(ws)) this.channels.set(ws, new Map());
    this.channels.get(ws)!.set(topic, { kind, channel });
    ws.subscribe(topic);
    return true;
  }
  unsubscribeChannel(
    ws: ServerWebSocket<RealtimeSocketData>,
    kind: "broadcast" | "presence",
    channel: string,
  ): void {
    const topic = channelTopic(kind, channel);
    this.channels.get(ws)?.delete(topic);
    ws.unsubscribe(topic);
    if (kind === "presence" && ws.data.auth) this.presence?.leave(channel, ws.data.auth.id, ws);
  }
  hasChannel(
    ws: ServerWebSocket<RealtimeSocketData>,
    kind: "broadcast" | "presence",
    channel: string,
  ): boolean {
    return this.channels.get(ws)?.has(channelTopic(kind, channel)) ?? false;
  }
  async pruneChannel(kind: "broadcast" | "presence", channel: string): Promise<void> {
    for (const [ws, topics] of this.channels) {
      if (
        topics.has(channelTopic(kind, channel)) &&
        !(await this.authorizeChannel(ws, kind, channel, "subscribe"))
      )
        this.unsubscribeChannel(ws, kind, channel);
    }
  }
  /** Reauthorize passive readers before every delivery. */
  async publish(
    topic: string,
    message: string,
    exclude?: ServerWebSocket<RealtimeSocketData>,
  ): Promise<void> {
    for (const [ws, topics] of this.channels) {
      const subscription = topics.get(topic);
      if (!subscription || ws === exclude) continue;
      if (
        !(await this.authorizeChannel(ws, subscription.kind, subscription.channel, "subscribe"))
      ) {
        this.unsubscribeChannel(ws, subscription.kind, subscription.channel);
        continue;
      }
      try {
        ws.send(message);
      } catch {
        /* Closed during delivery. */
      }
    }
  }
  // tableName → Set of subscribers
  private tableSubscribers: Map<string, Set<Subscriber>> = new Map();
  // tableName → Drizzle Table object
  private tableMap: Map<string, Table> = new Map();
  // tableName → Set of ws currently being added (synchronous reservation to prevent concurrent duplicates)
  private inFlight: Map<string, Set<ServerWebSocket<RealtimeSocketData>>> = new Map();
  // tableName → set of hidden schema keys (from the field policy + defaults)
  private hiddenByTable: Map<string, Set<string>> = new Map();

  constructor(
    private db: AnyDb,
    schema: Record<string, unknown>,
    private rules?: Record<string, TableRules>,
    fields?: FieldPolicyMap,
    private options: RealtimeOptions = {},
    private presence?: PresenceTracker,
  ) {
    this.limits = realtimeLimits(options);
    for (const value of Object.values(schema)) {
      if (typeof value !== "object" || value === null) continue;
      try {
        const name = getTableName(value as Table);
        if (!name.startsWith("_")) {
          this.tableMap.set(name, value as Table);
          // Precompute the hidden-field set so realtime payloads are scrubbed
          // exactly like HTTP responses (passwordHash + policy `hidden`).
          const policy = resolveFieldPolicy(
            getColumns(value as Table) as Record<string, Column>,
            fields?.[name],
          );
          this.hiddenByTable.set(name, policy.hidden);
        }
      } catch {
        // Not a Drizzle table — skip
      }
    }
  }

  async addTableSubscriber(
    ws: ServerWebSocket<RealtimeSocketData>,
    tableName: string,
  ): Promise<void> {
    const table = this.tableMap.get(tableName);
    if (!table) {
      this.sendTo(ws, { type: "error", message: `Unknown table: ${tableName}` });
      return;
    }

    // Synchronous reservation before any await: claim this (tableName, ws) slot so
    // concurrent calls from the same socket are rejected atomically.
    if (!this.inFlight.has(tableName)) this.inFlight.set(tableName, new Set());
    const inFlightSet = this.inFlight.get(tableName)!;
    if (inFlightSet.has(ws)) return; // already being processed
    const existing = this.tableSubscribers.get(tableName);
    if (existing) {
      for (const sub of existing) {
        if (sub.ws === ws) return; // already subscribed
      }
    }
    if (this.subscriptionCount(ws) >= this.limits.maxSubscriptions) {
      this.sendTo(ws, { type: "error", message: "Subscription limit exceeded" });
      return;
    }
    inFlightSet.add(ws); // reserve the slot

    try {
      if (!(await this.refreshAuth(ws))) return;
      const tableRules = this.rules?.[tableName];
      const ruleResult = await evaluateRule(tableRules?.list, {
        auth: ws.data.auth,
        body: {},
        headers: {},
        query: {},
        method: "SUBSCRIBE",
        db: this.db,
      });
      if (!ruleResult.allowed) {
        this.sendTo(ws, { type: "error", message: `Access denied to table: ${tableName}` });
        return;
      }

      const filtered = !!ruleResult.whereClause;
      const subscriber: Subscriber = {
        ws,
        filtered,
        whereClause: ruleResult.whereClause,
        visibleIds: new Set(),
      };

      // Seed visibleIds with all currently visible record IDs so that
      // DELETE and visible→invisible transitions work correctly after reconnect
      if (filtered && ruleResult.whereClause) {
        const columns = getColumns(table);
        const idColumn = columns.id as Column | undefined;
        if (idColumn) {
          const rows = await (this.db as any)
            .select({ id: idColumn })
            .from(table)
            .where(ruleResult.whereClause);
          for (const row of rows) {
            if (row.id != null) subscriber.visibleIds.add(String(row.id));
          }
        }
      }

      if (!this.tableSubscribers.has(tableName)) {
        this.tableSubscribers.set(tableName, new Set());
      }
      if (this.closed.has(ws)) return;
      this.tableSubscribers.get(tableName)?.add(subscriber);
    } finally {
      inFlightSet.delete(ws);
      if (inFlightSet.size === 0) this.inFlight.delete(tableName);
    }
  }

  removeTableSubscriber(ws: ServerWebSocket<RealtimeSocketData>, tableName: string): void {
    const subscribers = this.tableSubscribers.get(tableName);
    if (!subscribers) return;
    for (const sub of subscribers) {
      if (sub.ws === ws) {
        subscribers.delete(sub);
        break;
      }
    }
    if (subscribers.size === 0) {
      this.tableSubscribers.delete(tableName);
    }
  }

  removeAllSubscriptions(ws: ServerWebSocket<RealtimeSocketData>): void {
    this.closed.add(ws);
    this.sockets.delete(ws);
    this.channels.delete(ws);
    this.presence?.leaveAll(ws);
    ws.data.releaseConnection?.();
    for (const [tableName, subscribers] of this.tableSubscribers.entries()) {
      for (const sub of subscribers) {
        if (sub.ws === ws) {
          subscribers.delete(sub);
          // No break — remove all entries for this ws (defensive against past duplicates)
        }
      }
      if (subscribers.size === 0) {
        this.tableSubscribers.delete(tableName);
      }
    }
  }

  async broadcastTableChange(
    tableName: string,
    action: "INSERT" | "UPDATE" | "DELETE",
    rawRecord: Record<string, unknown>,
  ): Promise<void> {
    const subscribers = this.tableSubscribers.get(tableName);
    if (!subscribers || subscribers.size === 0) return;

    const table = this.tableMap.get(tableName);
    // Scrub hidden fields (passwordHash + policy `hidden`) before the record is
    // sent to any subscriber, matching the HTTP response stripping.
    const record = stripHidden(rawRecord, this.hiddenByTable.get(tableName));
    const id = record.id != null ? String(record.id) : "";

    for (const sub of subscribers) {
      if (!(await this.refreshAuth(sub.ws))) continue;
      const rule = await evaluateRule(this.rules?.[tableName]?.list, {
        auth: sub.ws.data.auth,
        body: {},
        headers: {},
        query: {},
        method: "SUBSCRIBE",
        db: this.db,
      });
      if (!rule.allowed) {
        this.removeTableSubscriber(sub.ws, tableName);
        continue;
      }
      sub.filtered = !!rule.whereClause;
      sub.whereClause = rule.whereClause;
      if (!sub.filtered) {
        if (id) {
          if (action === "DELETE") sub.visibleIds.delete(id);
          else sub.visibleIds.add(id);
        }
        // No filter — send the full event to this subscriber
        this.sendTo(sub.ws, { type: "table:change", table: tableName, action, record, id });
        continue;
      }

      // Filtered subscriber — apply per-subscriber visibility logic
      if (!table || !sub.whereClause) continue;

      const columns = getColumns(table);
      const idColumn = columns.id as Column | undefined;
      if (!idColumn) continue;

      if (action === "INSERT") {
        const visible = await this.checkVisibility(table, idColumn, id, sub.whereClause);
        if (visible) {
          sub.visibleIds.add(id);
          this.sendTo(sub.ws, {
            type: "table:change",
            table: tableName,
            action: "INSERT",
            record,
            id,
          });
        }
        // else: never visible — skip (no leak)
      } else if (action === "UPDATE") {
        const visible = await this.checkVisibility(table, idColumn, id, sub.whereClause);
        if (visible) {
          sub.visibleIds.add(id);
          this.sendTo(sub.ws, {
            type: "table:change",
            table: tableName,
            action: "UPDATE",
            record,
            id,
          });
        } else {
          if (sub.visibleIds.has(id)) {
            // Was visible before, now gone from filter — synthetic DELETE.
            // Do NOT include the post-update record: it now belongs to a scope
            // this subscriber cannot see, so sending it would leak hidden data.
            sub.visibleIds.delete(id);
            this.sendTo(sub.ws, { type: "table:change", table: tableName, action: "DELETE", id });
          }
          // else: was never visible — skip (no leak)
        }
      } else if (action === "DELETE") {
        if (sub.visibleIds.has(id)) {
          sub.visibleIds.delete(id);
          this.sendTo(sub.ws, {
            type: "table:change",
            table: tableName,
            action: "DELETE",
            // The row no longer exists, so its current visibility cannot be
            // checked against a changed membership/filter. Only invalidate it.
            id,
          });
        }
        // else: was never visible — skip (no leak)
      }
    }
  }

  private async checkVisibility(
    table: Table,
    idColumn: Column,
    id: string,
    whereClause: SQL,
  ): Promise<boolean> {
    const rows = await (this.db as any)
      .select({ id: idColumn })
      .from(table)
      .where(and(eq(idColumn, id), whereClause))
      .limit(1);
    return rows.length > 0;
  }

  private sendTo(ws: ServerWebSocket<RealtimeSocketData>, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Connection may be closing
    }
  }
}
