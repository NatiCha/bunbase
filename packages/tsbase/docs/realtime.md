---
title: Realtime
---

TSBase can push live updates to connected clients over WebSocket. Three features share a single connection: **table subscriptions** (stream INSERT/UPDATE/DELETE events from any table), **broadcast channels** (pub/sub for arbitrary messages), and **presence** (track who is online per channel).

## Enabling realtime

Realtime is opt-in. Add `realtime` to your config:

```ts
// src/index.ts
import { createServer, defineConfig } from "tsbase";
import * as schema from "./schema";

const tsbase = createServer({
  schema,
  config: defineConfig({
    realtime: { enabled: true },
  }),
});

tsbase.listen();
```

When enabled, a WebSocket endpoint is available at `ws://localhost:3000/realtime`.

## Client setup

Import the client and use the `realtime` namespace:

```ts
import { createTSBaseClient } from "tsbase/client";
import type * as schema from "../server/src/schema";

const client = createTSBaseClient<typeof schema>({
  url: "http://localhost:3000",
});

// client.realtime.subscribe()  — table change events
// client.realtime.channel()    — broadcast and presence
// client.realtime.disconnect() — clean up
```

The WebSocket connection is lazy — it opens the first time you call `subscribe()` or `channel(...).subscribe()`. It reconnects automatically if dropped.

---

## Table subscriptions

Subscribe to live INSERT, UPDATE, and DELETE events on any table. Access control uses the same `list` rule defined in your rules file — if a user cannot list a table, they cannot subscribe to it.

```ts
const unsub = client.realtime.subscribe("posts", (event) => {
  console.log(event.event);  // "INSERT" | "UPDATE" | "DELETE"
  console.log(event.id);     // record ID (always present)
  console.log(event.record); // full record (present on INSERT, UPDATE, and unfiltered DELETE)
});

// Later — stop receiving events and clean up
unsub();
```

Each event object has the shape:

```ts
interface TableChangeEvent {
  event: "INSERT" | "UPDATE" | "DELETE";
  id: string;
  record?: Record<string, unknown>;
  // Present on INSERT and UPDATE.
  // Present on DELETE for unfiltered subscribers (no list rule WHERE clause).
  // Absent on DELETE for filtered subscribers — only `id` is sent.
}
```

### Rule-filtered subscriptions

When a `list` rule returns a SQL `WHERE` clause (e.g. `ownerOnly`), each subscriber only receives events for records they are allowed to see. TSBase enforces this on the server — subscribers never see data outside their permitted scope.

The filtering logic handles all ownership-change scenarios:

| Scenario | Event received |
|---|---|
| INSERT — record visible to subscriber | `INSERT` with full record |
| INSERT — record not visible | Nothing |
| UPDATE — record remains visible | `UPDATE` with full record |
| UPDATE — record becomes visible (e.g. assigned to you) | `UPDATE` with full record |
| UPDATE — record becomes invisible (e.g. reassigned away) | Synthetic `DELETE` (id only) |
| DELETE — record was visible | `DELETE` (id only, no `record`) |
| DELETE — record was not visible | Nothing |

Unfiltered subscribers (no `list` rule, or a rule that returns `true`) receive `record` on DELETE events as well. The filtered id-only DELETE is an intentional constraint — by the time the delete fires, the record no longer exists in the database, so TSBase cannot re-query it to check visibility.

Example with an `ownerOnly` rule:

```ts
// src/rules.ts
import { defineRules, ownerOnly, authenticated } from "tsbase";
import { tasks } from "./schema";

export const rules = defineRules({
  tasks: {
    list: (ctx) => ownerOnly(tasks.ownerId, ctx), // only the owner sees their tasks
    create: (ctx) => authenticated(ctx),
    update: (ctx) => ownerOnly(tasks.ownerId, ctx),
    delete: (ctx) => ownerOnly(tasks.ownerId, ctx),
  },
});
```

```ts
// Client — Alice only receives events for her own tasks
const unsub = client.realtime.subscribe("tasks", (event) => {
  if (event.event === "INSERT") addTask(event.record!);
  if (event.event === "UPDATE") updateTask(event.id, event.record!);
  if (event.event === "DELETE") removeTask(event.id);
});
```

If the `list` rule denies the subscription entirely, the server sends an error and the subscription is not established.

### React example

```tsx
import { useEffect, useState } from "react";

function TaskList() {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    // Load initial data
    client.api.tasks.list().then(({ data }) => setTasks(data));

    // Subscribe to live updates
    const unsub = client.realtime.subscribe("tasks", (event) => {
      if (event.event === "INSERT") {
        setTasks((prev) => [...prev, event.record as Task]);
      } else if (event.event === "UPDATE") {
        setTasks((prev) =>
          prev.map((t) => (t.id === event.id ? (event.record as Task) : t))
        );
      } else if (event.event === "DELETE") {
        setTasks((prev) => prev.filter((t) => t.id !== event.id));
      }
    });

    return unsub; // cleanup on unmount
  }, []);

  return <ul>{tasks.map((t) => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

---

## Broadcast channels

Broadcast lets authenticated clients send arbitrary messages to each other over named channels. Messages are not persisted.

```ts
// Subscribe to a channel
const channel = client.realtime.channel("room:abc");

channel
  .on("cursor-move", (payload) => {
    console.log(payload); // { x: 42, y: 100 }
  })
  .on("drawing", (payload) => {
    renderStroke(payload);
  })
  .subscribe(); // join the channel

// Send a message to everyone in the channel (including yourself)
channel.broadcast("cursor-move", { x: 42, y: 100 });

// Leave
channel.unsubscribe();
```

`channel.subscribe()` returns the channel client, so you can chain `.on()` and `.subscribe()` calls in any order:

```ts
client.realtime
  .channel("notifications")
  .on("alert", handleAlert)
  .subscribe();
```

**Authentication required.** Unauthenticated clients receive an error if they attempt to subscribe to or broadcast on a channel.

`channel.broadcast()` is safe to call before the WebSocket connection is open — the message is queued and sent once the connection is established.

---

## Presence

Presence tracks which users are online in a channel, along with optional metadata (display name, avatar, cursor position, etc.). All presence features are available on a channel object.

### Joining and leaving

```ts
const channel = client.realtime.channel("document:123");

channel
  .onPresence((event) => {
    if (event.type === "state") {
      // Initial snapshot of everyone currently online
      setOnlineUsers(event.users);
    } else if (event.type === "join") {
      // Someone joined — event.user = { userId, meta }
      addUser(event.user);
    } else if (event.type === "leave") {
      // Someone left — event.userId
      removeUser(event.userId);
    } else if (event.type === "update") {
      // Someone updated their metadata
      updateUser(event.user);
    }
  })
  .track({ name: "Alice", avatar: "https://..." }); // join presence with metadata
```

`track()` sends your presence to the channel. You immediately receive a `state` event with the full list of users currently online (including yourself).

To stop broadcasting your presence without leaving the channel:

```ts
channel.untrack();
```

To leave the channel entirely:

```ts
channel.unsubscribe(); // leaves both broadcast and presence
```

### Presence event types

```ts
type PresenceEvent =
  | { type: "state";  channel: string; users: PresenceUser[] }
  | { type: "join";   channel: string; user: PresenceUser }
  | { type: "leave";  channel: string; userId: string }
  | { type: "update"; channel: string; user: PresenceUser };

interface PresenceUser {
  userId: string;
  meta: Record<string, unknown>;
}
```

### Collaborative cursor example

```ts
const channel = client.realtime.channel("doc:123");

// Track own cursor, observe others
channel
  .onPresence((event) => {
    if (event.type === "state") renderCursors(event.users);
    if (event.type === "join")  addCursor(event.user);
    if (event.type === "leave") removeCursor(event.userId);
    if (event.type === "update") moveCursor(event.user);
  })
  .track({ name: currentUser.name, color: "#ff6b6b" });

// Update your cursor position as you move
document.addEventListener("mousemove", ({ clientX, clientY }) => {
  channel.broadcast("cursor", { x: clientX, y: clientY });
});
```

**Authentication required.** Unauthenticated clients receive an error on `track()`.

---

## Disconnecting

Call `disconnect()` to close the WebSocket and stop all subscriptions:

```ts
client.realtime.disconnect();
```

This clears all table subscriptions, channel subscriptions, and presence state. The connection will not reconnect after `disconnect()` is called.

---

## Security model

| Feature | Auth required | Access control |
|---|---|---|
| Table subscriptions | Per `list` rule | `list` rule evaluated at subscribe time; WHERE clause applied per-event |
| Broadcast subscribe | Yes | Authenticated users only |
| Broadcast send | Yes | Authenticated users only |
| Presence track | Yes | Authenticated users only |

Auth is extracted from the session cookie when the WebSocket connection is upgraded. The session is snapshotted at connect time — if a user's role or session changes, they must reconnect for it to take effect. This matches the behavior of Supabase and Firebase Realtime.

---

## Configuration reference

```ts
defineConfig({
  realtime: {
    enabled: true, // default: false
  },
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `realtime.enabled` | `boolean` | `false` | Enable the WebSocket endpoint at `/realtime` |

---

## Raw WebSocket protocol

If you are not using the client SDK, you can connect directly over WebSocket and exchange JSON messages.

### Connect

```
ws://localhost:3000/realtime
```

Session authentication is read from the `Cookie` header on the upgrade request. Unauthenticated connections can still subscribe to public tables.

### Client → server messages

| `type` | Fields | Auth required |
|---|---|---|
| `subscribe:table` | `table: string` | Per `list` rule |
| `unsubscribe:table` | `table: string` | No |
| `subscribe:broadcast` | `channel: string` | Yes |
| `unsubscribe:broadcast` | `channel: string` | No |
| `broadcast` | `channel`, `event`, `payload` | Yes |
| `subscribe:presence` | `channel: string`, `meta?: object` | Yes |
| `unsubscribe:presence` | `channel: string` | No |
| `presence:update` | `channel: string`, `meta: object` | Yes |

### Server → client messages

| `type` | Fields |
|---|---|
| `table:change` | `table`, `event` (INSERT/UPDATE/DELETE), `id`, `record?` |
| `broadcast` | `channel`, `event`, `payload` |
| `presence:state` | `channel`, `users[]` |
| `presence:join` | `channel`, `user` |
| `presence:leave` | `channel`, `userId` |
| `presence:update` | `channel`, `user` |
| `error` | `message` |

### Example session

```json
// Subscribe to a table
→ { "type": "subscribe:table", "table": "posts" }

// Receive a change event
← { "type": "table:change", "table": "posts", "event": "INSERT", "id": "abc", "record": { ... } }

// Join a presence channel
→ { "type": "subscribe:presence", "channel": "doc:1", "meta": { "name": "Alice" } }

// Receive current state
← { "type": "presence:state", "channel": "doc:1", "users": [{ "userId": "u1", "meta": { "name": "Alice" } }] }

// Broadcast a message
→ { "type": "broadcast", "channel": "doc:1", "event": "cursor", "payload": { "x": 42, "y": 100 } }
```

---

## Next steps

- [Rules](/rules/) — control which tables clients can subscribe to
- [Client SDK](/client/) — full client reference
- [Configuration](/configuration/) — all config options
