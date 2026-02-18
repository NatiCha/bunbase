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

test("getClientIp reads first entry from x-forwarded-for header", () => {
  const req = new Request("http://localhost", {
    headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
  });
  expect(getClientIp(req)).toBe("203.0.113.5");
});

test("getClientIp falls back to x-real-ip", () => {
  const req = new Request("http://localhost", {
    headers: { "x-real-ip": "203.0.113.99" },
  });
  expect(getClientIp(req)).toBe("203.0.113.99");
});

test("getClientIp returns 'unknown' when no headers present", () => {
  const req = new Request("http://localhost");
  expect(getClientIp(req)).toBe("unknown");
});
