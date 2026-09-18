import { z } from "zod/v4";
import type { AuthUser } from "../api/types.ts";
import type { AnyDb } from "../core/db-types.ts";

export interface ChannelContext {
  auth: AuthUser;
  db: AnyDb;
  channel: string;
  kind: "broadcast" | "presence";
  action: "subscribe" | "publish" | "update";
}
export interface RealtimeOptions {
  authorize?: (context: ChannelContext) => boolean | Promise<boolean>;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}
export const DEFAULT_LIMITS = {
  maxMessageBytes: 65536,
  maxDataBytes: 16384,
  maxDepth: 16,
  maxSubscriptions: 32,
  messagesPerWindow: 60,
  windowMs: 10000,
  maxPendingMessages: 16,
  maxConnectionsPerIp: 32,
  maxConnectionsPerUser: 8,
};
export function realtimeLimits(options: RealtimeOptions = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`BunBase: realtime.limits.${name} must be a positive integer`);
  }
  return limits;
}
const name = z.string().min(1).max(128);
const meta = z.record(z.string(), z.unknown());
const messageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("subscribe:table"), table: name }),
  z.strictObject({ type: z.literal("unsubscribe:table"), table: name }),
  z.strictObject({ type: z.literal("subscribe:broadcast"), channel: name }),
  z.strictObject({ type: z.literal("unsubscribe:broadcast"), channel: name }),
  z.strictObject({
    type: z.literal("broadcast"),
    channel: name,
    event: name,
    payload: z.unknown(),
  }),
  z.strictObject({ type: z.literal("subscribe:presence"), channel: name, meta: meta.optional() }),
  z.strictObject({ type: z.literal("unsubscribe:presence"), channel: name }),
  z.strictObject({ type: z.literal("presence:update"), channel: name, meta }),
]);
export function parseMessage(raw: string | Buffer, limits: typeof DEFAULT_LIMITS) {
  const text = typeof raw === "string" ? raw : raw.toString();
  if (Buffer.byteLength(text) > limits.maxMessageBytes) throw new Error("Message too large");
  const value: unknown = JSON.parse(text);
  function checkDepth(value: unknown, depth: number): void {
    if (depth > limits.maxDepth) throw new Error("Message nesting too deep");
    if (value && typeof value === "object")
      for (const child of Object.values(value)) checkDepth(child, depth + 1);
  }
  checkDepth(value, 0);
  const message = messageSchema.parse(value);
  if (
    ("payload" in message &&
      Buffer.byteLength(JSON.stringify(message.payload) ?? "") > limits.maxDataBytes) ||
    ("meta" in message &&
      Buffer.byteLength(JSON.stringify(message.meta) ?? "") > limits.maxDataBytes)
  )
    throw new Error("Message data too large");
  return message;
}
export function channelTopic(kind: "broadcast" | "presence", channel: string): string {
  return `bunbase:${kind}:${channel}`;
}
