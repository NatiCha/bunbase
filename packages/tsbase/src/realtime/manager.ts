import { getTableName, getColumns, eq, and } from "drizzle-orm";
import type { SQL, Table, Column } from "drizzle-orm";
import type { ServerWebSocket } from "bun";
import type { AnyDb } from "../core/db-types.ts";
import type { TableRules } from "../rules/types.ts";
import type { RealtimeSocketData, ServerMessage } from "./types.ts";
import { evaluateRule } from "../rules/evaluator.ts";

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
  // tableName → Set of subscribers
  private tableSubscribers: Map<string, Set<Subscriber>> = new Map();
  // tableName → Drizzle Table object
  private tableMap: Map<string, Table> = new Map();
  // tableName → Set of ws currently being added (synchronous reservation to prevent concurrent duplicates)
  private inFlight: Map<string, Set<ServerWebSocket<RealtimeSocketData>>> = new Map();

  constructor(
    private db: AnyDb,
    schema: Record<string, unknown>,
    private rules?: Record<string, TableRules>,
  ) {
    for (const value of Object.values(schema)) {
      if (typeof value !== "object" || value === null) continue;
      try {
        const name = getTableName(value as Table);
        if (!name.startsWith("_")) {
          this.tableMap.set(name, value as Table);
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
    inFlightSet.add(ws); // reserve the slot

    try {
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
        const idColumn = columns["id"] as Column | undefined;
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
      this.tableSubscribers.get(tableName)!.add(subscriber);
    } finally {
      inFlightSet.delete(ws);
      if (inFlightSet.size === 0) this.inFlight.delete(tableName);
    }
  }

  removeTableSubscriber(
    ws: ServerWebSocket<RealtimeSocketData>,
    tableName: string,
  ): void {
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
    record: Record<string, unknown>,
  ): Promise<void> {
    const subscribers = this.tableSubscribers.get(tableName);
    if (!subscribers || subscribers.size === 0) return;

    const table = this.tableMap.get(tableName);
    const id = record["id"] != null ? String(record["id"]) : "";

    for (const sub of subscribers) {
      if (!sub.filtered) {
        // No filter — send the full event to this subscriber
        this.sendTo(sub.ws, { type: "table:change", table: tableName, action, record, id });
        continue;
      }

      // Filtered subscriber — apply per-subscriber visibility logic
      if (!table || !sub.whereClause) continue;

      const columns = getColumns(table);
      const idColumn = columns["id"] as Column | undefined;
      if (!idColumn) continue;

      if (action === "INSERT") {
        const visible = await this.checkVisibility(table, idColumn, id, sub.whereClause);
        if (visible) {
          sub.visibleIds.add(id);
          this.sendTo(sub.ws, { type: "table:change", table: tableName, action: "INSERT", record, id });
        }
        // else: never visible — skip (no leak)
      } else if (action === "UPDATE") {
        const visible = await this.checkVisibility(table, idColumn, id, sub.whereClause);
        if (visible) {
          sub.visibleIds.add(id);
          this.sendTo(sub.ws, { type: "table:change", table: tableName, action: "UPDATE", record, id });
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
          this.sendTo(sub.ws, { type: "table:change", table: tableName, action: "DELETE", record, id });
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
