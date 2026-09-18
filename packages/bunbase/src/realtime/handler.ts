import type { Server, ServerWebSocket } from "bun";
import type { RealtimeManager } from "./manager.ts";
import type { PresenceTracker } from "./presence.ts";
import { channelTopic, parseMessage } from "./security.ts";
import type { ClientMessage, RealtimeSocketData, ServerMessage } from "./types.ts";

/**
 * WebSocket message/close handlers for BunBase realtime protocol.
 * @module
 */

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
  _server: Server<unknown>,
  manager: RealtimeManager,
  presence: PresenceTracker,
): Promise<void> {
  return manager.enqueue(ws, async () => {
    let msg: ClientMessage;
    try {
      msg = parseMessage(raw, manager.limits);
    } catch {
      sendTo(ws, { type: "error", message: "Invalid realtime message" });
      return;
    }

    if (!(await manager.refreshAuth(ws))) return;
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
        await manager.subscribeChannel(ws, "broadcast", msg.channel);
        break;

      case "unsubscribe:broadcast":
        manager.unsubscribeChannel(ws, "broadcast", msg.channel);
        break;

      case "broadcast":
        if (!auth) {
          sendTo(ws, { type: "error", message: "Authentication required for broadcast" });
          return;
        }
        if (!(await manager.authorizeChannel(ws, "broadcast", msg.channel, "publish"))) {
          sendTo(ws, { type: "error", message: "Channel publish denied" });
          return;
        }
        await manager.publish(
          channelTopic("broadcast", msg.channel),
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
        if (!(await manager.subscribeChannel(ws, "presence", msg.channel))) return;
        await manager.pruneChannel("presence", msg.channel);
        if (!manager.hasChannel(ws, "presence", msg.channel)) return;
        const meta = msg.meta ?? {};
        const { isNew } = presence.join(msg.channel, auth.id, meta, ws);
        // Notify existing subscribers, excluding the joining socket.
        if (isNew) {
          await manager.publish(
            channelTopic("presence", msg.channel),
            JSON.stringify({
              type: "presence:join",
              channel: msg.channel,
              user: { userId: auth.id, meta },
            } satisfies ServerMessage),
            ws,
          );
        }

        // Membership may change during the asynchronous join notification.
        await manager.pruneChannel("presence", msg.channel);
        if (!manager.hasChannel(ws, "presence", msg.channel)) return;
        sendTo(ws, {
          type: "presence:state",
          channel: msg.channel,
          users: presence.getUsers(msg.channel),
        });
        break;
      }

      case "unsubscribe:presence": {
        if (!auth) return;
        const { isEmpty } = presence.leave(msg.channel, auth.id, ws);
        manager.unsubscribeChannel(ws, "presence", msg.channel);
        if (isEmpty) {
          await manager.publish(
            channelTopic("presence", msg.channel),
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
        if (
          !manager.hasChannel(ws, "presence", msg.channel) ||
          !(await manager.authorizeChannel(ws, "presence", msg.channel, "update"))
        ) {
          sendTo(ws, { type: "error", message: "Presence update denied" });
          return;
        }
        presence.updateMeta(msg.channel, auth.id, msg.meta);
        const users = presence.getUsers(msg.channel);
        const user = users.find((u) => u.userId === auth.id);
        if (user) {
          await manager.publish(
            channelTopic("presence", msg.channel),
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
  });
}

export function handleWebSocketClose(
  ws: ServerWebSocket<RealtimeSocketData>,
  _server: Server<unknown>,
  manager: RealtimeManager,
  presence: PresenceTracker,
): void {
  const left = presence.leaveAll(ws);
  manager.removeAllSubscriptions(ws);
  for (const { channel, userId } of left) {
    void manager.publish(
      channelTopic("presence", channel),
      JSON.stringify({
        type: "presence:leave",
        channel,
        userId,
      } satisfies ServerMessage),
    );
  }
}
