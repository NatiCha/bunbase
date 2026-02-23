/**
 * Unit tests for PresenceTracker
 */
import { describe, expect, test } from "bun:test";
import { PresenceTracker } from "../realtime/presence.ts";

// Fake WS references — just objects for identity comparison
const ws1 = { id: "ws1" };
const ws2 = { id: "ws2" };
const ws3 = { id: "ws3" };

describe("PresenceTracker.join", () => {
  test("first join is new", () => {
    const tracker = new PresenceTracker();
    const { isNew } = tracker.join("room:1", "user-a", { name: "Alice" }, ws1);
    expect(isNew).toBe(true);
  });

  test("second connection from same user is not new", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", { name: "Alice" }, ws1);
    const { isNew } = tracker.join("room:1", "user-a", { name: "Alice" }, ws2);
    expect(isNew).toBe(false);
  });

  test("different users in same channel are both new", () => {
    const tracker = new PresenceTracker();
    const r1 = tracker.join("room:1", "user-a", {}, ws1);
    const r2 = tracker.join("room:1", "user-b", {}, ws2);
    expect(r1.isNew).toBe(true);
    expect(r2.isNew).toBe(true);
  });

  test("getUsers reflects joined users", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", { name: "Alice" }, ws1);
    tracker.join("room:1", "user-b", { name: "Bob" }, ws2);
    const users = tracker.getUsers("room:1");
    expect(users).toHaveLength(2);
    const ids = users.map((u) => u.userId).sort();
    expect(ids).toEqual(["user-a", "user-b"]);
  });

  test("meta is merged on second join from same user", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", { name: "Alice" }, ws1);
    tracker.join("room:1", "user-a", { status: "online" }, ws2);
    const users = tracker.getUsers("room:1");
    expect(users[0]!.meta).toMatchObject({ name: "Alice", status: "online" });
  });
});

describe("PresenceTracker.leave", () => {
  test("leave with single connection removes user", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", {}, ws1);
    const { isEmpty } = tracker.leave("room:1", "user-a", ws1);
    expect(isEmpty).toBe(true);
    expect(tracker.getUsers("room:1")).toHaveLength(0);
  });

  test("leave with two connections keeps user until last connection leaves", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", {}, ws1);
    tracker.join("room:1", "user-a", {}, ws2);

    const first = tracker.leave("room:1", "user-a", ws1);
    expect(first.isEmpty).toBe(false);
    expect(tracker.getUsers("room:1")).toHaveLength(1);

    const second = tracker.leave("room:1", "user-a", ws2);
    expect(second.isEmpty).toBe(true);
    expect(tracker.getUsers("room:1")).toHaveLength(0);
  });

  test("leave unknown channel returns isEmpty=true", () => {
    const tracker = new PresenceTracker();
    const { isEmpty } = tracker.leave("room:unknown", "user-a", ws1);
    expect(isEmpty).toBe(true);
  });

  test("leave unknown user returns isEmpty=true", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", {}, ws1);
    const { isEmpty } = tracker.leave("room:1", "user-b", ws2);
    expect(isEmpty).toBe(true);
  });
});

describe("PresenceTracker.leaveAll", () => {
  test("leaveAll cleans up a connection from multiple channels", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", {}, ws1);
    tracker.join("room:2", "user-a", {}, ws1);
    tracker.join("room:3", "user-b", {}, ws2);

    const left = tracker.leaveAll(ws1);
    expect(left).toHaveLength(2);
    const channels = left.map((l) => l.channel).sort();
    expect(channels).toEqual(["room:1", "room:2"]);

    // user-b still present in room:3
    expect(tracker.getUsers("room:3")).toHaveLength(1);
    // user-a gone from all their rooms
    expect(tracker.getUsers("room:1")).toHaveLength(0);
    expect(tracker.getUsers("room:2")).toHaveLength(0);
  });

  test("leaveAll with no tracked channels returns empty array", () => {
    const tracker = new PresenceTracker();
    const left = tracker.leaveAll(ws1);
    expect(left).toHaveLength(0);
  });

  test("leaveAll with two connections only removes the specified ws", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", {}, ws1);
    tracker.join("room:1", "user-a", {}, ws2); // second connection

    const left = tracker.leaveAll(ws1);
    // user-a still has ws2, so not isEmpty → not in results
    expect(left).toHaveLength(0);
    expect(tracker.getUsers("room:1")).toHaveLength(1);
  });
});

describe("PresenceTracker.updateMeta", () => {
  test("updateMeta merges new fields", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", { name: "Alice", status: "away" }, ws1);
    tracker.updateMeta("room:1", "user-a", { status: "online", cursor: { x: 10 } });
    const users = tracker.getUsers("room:1");
    expect(users[0]!.meta).toMatchObject({ name: "Alice", status: "online", cursor: { x: 10 } });
  });

  test("updateMeta on unknown channel is a no-op", () => {
    const tracker = new PresenceTracker();
    // Should not throw
    tracker.updateMeta("room:unknown", "user-a", { status: "online" });
  });

  test("updateMeta on unknown user is a no-op", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", {}, ws1);
    tracker.updateMeta("room:1", "user-b", { status: "online" });
    // user-a unaffected
    expect(tracker.getUsers("room:1")[0]!.userId).toBe("user-a");
  });
});

describe("PresenceTracker.getUsers", () => {
  test("getUsers returns empty array for unknown channel", () => {
    const tracker = new PresenceTracker();
    expect(tracker.getUsers("room:unknown")).toEqual([]);
  });

  test("getUsers includes userId and meta", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", { name: "Alice" }, ws1);
    const users = tracker.getUsers("room:1");
    expect(users[0]).toEqual({ userId: "user-a", meta: { name: "Alice" } });
  });

  test("multiple users across different channels are isolated", () => {
    const tracker = new PresenceTracker();
    tracker.join("room:1", "user-a", {}, ws1);
    tracker.join("room:2", "user-b", {}, ws2);
    tracker.join("room:2", "user-c", {}, ws3);

    expect(tracker.getUsers("room:1")).toHaveLength(1);
    expect(tracker.getUsers("room:2")).toHaveLength(2);
  });
});
