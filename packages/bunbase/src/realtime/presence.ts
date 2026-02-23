import type { PresenceUser } from "./types.ts";

/**
 * In-memory presence tracker keyed by channel and user id.
 * @module
 */

interface PresenceEntry {
  meta: Record<string, unknown>;
  connections: Set<unknown>;
}

export class PresenceTracker {
  // channel → userId → { meta, connections }
  private state: Map<string, Map<string, PresenceEntry>> = new Map();

  join(
    channel: string,
    userId: string,
    meta: Record<string, unknown>,
    wsRef: unknown,
  ): { isNew: boolean } {
    if (!this.state.has(channel)) {
      this.state.set(channel, new Map());
    }
    const channelMap = this.state.get(channel)!;
    const isNew = !channelMap.has(userId);
    if (isNew) {
      channelMap.set(userId, { meta, connections: new Set([wsRef]) });
    } else {
      const entry = channelMap.get(userId)!;
      entry.connections.add(wsRef);
      entry.meta = { ...entry.meta, ...meta };
    }
    return { isNew };
  }

  leave(channel: string, userId: string, wsRef: unknown): { isEmpty: boolean } {
    const channelMap = this.state.get(channel);
    if (!channelMap) return { isEmpty: true };

    const entry = channelMap.get(userId);
    if (!entry) return { isEmpty: true };

    entry.connections.delete(wsRef);
    if (entry.connections.size === 0) {
      channelMap.delete(userId);
      if (channelMap.size === 0) {
        this.state.delete(channel);
      }
      return { isEmpty: true };
    }
    return { isEmpty: false };
  }

  leaveAll(wsRef: unknown): Array<{ channel: string; userId: string }> {
    const results: Array<{ channel: string; userId: string }> = [];
    for (const [channel, channelMap] of this.state.entries()) {
      for (const [userId, entry] of channelMap.entries()) {
        entry.connections.delete(wsRef);
        if (entry.connections.size === 0) {
          channelMap.delete(userId);
          results.push({ channel, userId });
        }
      }
      if (channelMap.size === 0) {
        this.state.delete(channel);
      }
    }
    return results;
  }

  updateMeta(channel: string, userId: string, meta: Record<string, unknown>): void {
    const channelMap = this.state.get(channel);
    if (!channelMap) return;
    const entry = channelMap.get(userId);
    if (!entry) return;
    entry.meta = { ...entry.meta, ...meta };
  }

  getUsers(channel: string): PresenceUser[] {
    const channelMap = this.state.get(channel);
    if (!channelMap) return [];
    return Array.from(channelMap.entries()).map(([userId, entry]) => ({
      userId,
      meta: entry.meta,
    }));
  }
}
