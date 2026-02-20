import type { AuthUser } from "../api/types.ts";

export interface RealtimeSocketData {
  auth: AuthUser | null;
  connectedAt: number;
  presenceMeta: Record<string, unknown>;
}

// Client → Server messages
export type ClientMessage =
  | { type: "subscribe:table"; table: string }
  | { type: "unsubscribe:table"; table: string }
  | { type: "subscribe:broadcast"; channel: string }
  | { type: "unsubscribe:broadcast"; channel: string }
  | { type: "broadcast"; channel: string; event: string; payload: unknown }
  | { type: "subscribe:presence"; channel: string; meta?: Record<string, unknown> }
  | { type: "unsubscribe:presence"; channel: string }
  | { type: "presence:update"; channel: string; meta: Record<string, unknown> };

// Server → Client messages
export type ServerMessage =
  | { type: "table:change"; table: string; event: "INSERT" | "UPDATE" | "DELETE"; record?: Record<string, unknown>; id: string }
  | { type: "broadcast"; channel: string; event: string; payload: unknown }
  | { type: "presence:state"; channel: string; users: PresenceUser[] }
  | { type: "presence:join"; channel: string; user: PresenceUser }
  | { type: "presence:leave"; channel: string; userId: string }
  | { type: "presence:update"; channel: string; user: PresenceUser }
  | { type: "error"; message: string };

export interface PresenceUser {
  userId: string;
  meta: Record<string, unknown>;
}
