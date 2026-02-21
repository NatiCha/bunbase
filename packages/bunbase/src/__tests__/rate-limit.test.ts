import { test, expect } from "bun:test";
import { checkRateLimit, getClientIp } from "../auth/rate-limit.ts";

// Use a counter-based unique IP per test to prevent cross-test state pollution
// from the module-level store shared within a Bun worker.
let _counter = 0;
function freshIp(): string {
  return `10.99.0.${++_counter}`;
}

// checkRateLimit

test("first request is allowed with full remaining count", () => {
  const result = checkRateLimit(freshIp());
  expect(result.allowed).toBe(true);
  expect(result.remaining).toBe(9);
  expect(result.retryAfterMs).toBe(0);
});

test("subsequent requests within window decrement remaining", () => {
  const ip = freshIp();
  checkRateLimit(ip); // 1st
  checkRateLimit(ip); // 2nd
  const third = checkRateLimit(ip); // 3rd
  expect(third.allowed).toBe(true);
  expect(third.remaining).toBe(7);
});

test("request beyond the limit is blocked", () => {
  const ip = freshIp();
  for (let i = 0; i < 10; i++) {
    checkRateLimit(ip);
  }
  const blocked = checkRateLimit(ip);
  expect(blocked.allowed).toBe(false);
  expect(blocked.remaining).toBe(0);
  expect(blocked.retryAfterMs).toBeGreaterThan(0);
});

// getClientIp

test("getClientIp returns socket IP when no trusted proxies configured", () => {
  const req = new Request("http://localhost", {
    headers: {
      "x-bunbase-socket-ip": "1.2.3.4",
      "x-forwarded-for": "203.0.113.5",
    },
  });
  // No trusted proxies — forwarded header is ignored, socket IP is used
  expect(getClientIp(req, [])).toBe("1.2.3.4");
});

test("getClientIp parses x-forwarded-for right-to-left and returns first non-trusted hop", () => {
  // nginx $proxy_add_x_forwarded_for appends connecting IP on the right.
  // The leftmost value is client-controlled and could be spoofed.
  const req = new Request("http://localhost", {
    headers: {
      "x-bunbase-socket-ip": "127.0.0.1",
      "x-forwarded-for": "attacker-spoofed, 203.0.113.5, 127.0.0.1",
    },
  });
  // 127.0.0.1 (rightmost) is trusted → skip; 203.0.113.5 is the real client
  expect(getClientIp(req, ["127.0.0.1"])).toBe("203.0.113.5");
});

test("getClientIp with spoofed leading XFF entry returns true client, not spoofed IP", () => {
  const req = new Request("http://localhost", {
    headers: {
      "x-bunbase-socket-ip": "10.0.0.1",
      "x-forwarded-for": "1.1.1.1, 5.5.5.5",
    },
  });
  // 10.0.0.1 is trusted; 5.5.5.5 is the real connecting client; 1.1.1.1 is spoofed
  expect(getClientIp(req, ["10.0.0.1"])).toBe("5.5.5.5");
});

test("getClientIp falls back to x-real-ip when x-forwarded-for absent and proxy trusted", () => {
  const req = new Request("http://localhost", {
    headers: {
      "x-bunbase-socket-ip": "10.0.0.2",
      "x-real-ip": "203.0.113.99",
    },
  });
  expect(getClientIp(req, ["10.0.0.2"])).toBe("203.0.113.99");
});

test("getClientIp returns socket IP when connection is not from a trusted proxy", () => {
  const req = new Request("http://localhost", {
    headers: {
      "x-bunbase-socket-ip": "5.5.5.5",
      "x-forwarded-for": "203.0.113.5",
    },
  });
  // 5.5.5.5 is not in trusted list — forwarded header ignored
  expect(getClientIp(req, ["127.0.0.1"])).toBe("5.5.5.5");
});

test("getClientIp returns a random UUID when socket IP header is absent (programmatic call)", () => {
  const req = new Request("http://localhost");
  const ip = getClientIp(req, []);
  // Should be a valid UUID — not "unknown", not empty
  expect(ip).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
