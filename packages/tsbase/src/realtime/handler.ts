import type { ServerWebSocket, Server } from "bun";
import type { RealtimeSocketData, ClientMessage, ServerMessage } from "./types.ts";
import type { RealtimeManager } from "./manager.ts";
import type { PresenceTracker } from "./presence.ts";

function sendTo(ws: ServerWebSocket<RealtimeSocketData>, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may be closing
  }
}

export async function handleWebSocketMessage(
  ws: ServerWebSocket<RealtimeSocketData>,
  raw: string | Buffer,
  server: Server,
  manager: RealtimeManager,
  presence: PresenceTracker,
): Promise<void> {
  let msg: ClientMessage;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    msg = JSON.parse(text) as ClientMessage;
  } catch {
    sendTo(ws, { type: "error", message: "Invalid JSON message" });
    return;
  }

  const auth = ws.data.auth;

  switch (msg.type) {
    case "subscribe:table":
      await manager.addTableSubscriber(ws, msg.table);
      break;

    case "unsubscribe:table":
      manager.removeTableSubscriber(ws, msg.table);
      break;

    case "subscribe:broadcast":
      if (!auth) {
        sendTo(ws, { type: "error", message: "Authentication required for broadcast" });
        return;
      }
      ws.subscribe(msg.channel);
      break;

    case "unsubscribe:broadcast":
      ws.unsubscribe(msg.channel);
      break;

    case "broadcast":
      if (!auth) {
        sendTo(ws, { type: "error", message: "Authentication required for broadcast" });
        return;
      }
      server.publish(
        msg.channel,
        JSON.stringify({
          type: "broadcast",
          channel: msg.channel,
          event: msg.event,
          payload: msg.payload,
        } satisfies ServerMessage),
      );
      break;

    case "subscribe:presence": {
      if (!auth) {
        sendTo(ws, { type: "error", message: "Authentication required for presence" });
        return;
      }
      const meta = msg.meta ?? {};
      const { isNew } = presence.join(msg.channel, auth.id, meta, ws);
      const users = presence.getUsers(msg.channel);

      // Publish join to existing subscribers BEFORE this WS subscribes to the topic,
      // so the joining client does NOT receive its own join notification.
      if (isNew) {
        server.publish(
          `presence:${msg.channel}`,
          JSON.stringify({
            type: "presence:join",
            channel: msg.channel,
            user: { userId: auth.id, meta },
          } satisfies ServerMessage),
        );
      }

      // Now subscribe to presence pub/sub topic for future join/leave/update notifications
      ws.subscribe(`presence:${msg.channel}`);

      // Send current state directly to the joining client
      sendTo(ws, { type: "presence:state", channel: msg.channel, users });
      break;
    }

    case "unsubscribe:presence": {
      if (!auth) return;
      const { isEmpty } = presence.leave(msg.channel, auth.id, ws);
      ws.unsubscribe(`presence:${msg.channel}`);
      if (isEmpty) {
        server.publish(
          `presence:${msg.channel}`,
          JSON.stringify({
            type: "presence:leave",
            channel: msg.channel,
            userId: auth.id,
          } satisfies ServerMessage),
        );
      }
      break;
    }

    case "presence:update": {
      if (!auth) {
        sendTo(ws, { type: "error", message: "Authentication required for presence" });
        return;
      }
      presence.updateMeta(msg.channel, auth.id, msg.meta);
      const users = presence.getUsers(msg.channel);
      const user = users.find((u) => u.userId === auth.id);
      if (user) {
        server.publish(
          `presence:${msg.channel}`,
          JSON.stringify({
            type: "presence:update",
            channel: msg.channel,
            user,
          } satisfies ServerMessage),
        );
      }
      break;
    }

    default:
      sendTo(ws, { type: "error", message: "Unknown message type" });
  }
}

export function handleWebSocketClose(
  ws: ServerWebSocket<RealtimeSocketData>,
  server: Server,
  manager: RealtimeManager,
  presence: PresenceTracker,
): void {
  manager.removeAllSubscriptions(ws);

  const left = presence.leaveAll(ws);
  for (const { channel, userId } of left) {
    server.publish(
      `presence:${channel}`,
      JSON.stringify({
        type: "presence:leave",
        channel,
        userId,
      } satisfies ServerMessage),
    );
  }
}
