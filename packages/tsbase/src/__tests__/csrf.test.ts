import { test, expect } from "bun:test";
import { validateCsrf, isCsrfExempt, setCsrfCookie } from "../auth/csrf.ts";

// validateCsrf

test("validateCsrf passes when cookie and header tokens match", () => {
  const token = "test-token-abc";
  const req = new Request("http://localhost/auth/me", {
    headers: {
      cookie: `csrf_token=${token}`,
      "x-csrf-token": token,
    },
  });
  expect(validateCsrf(req)).toBe(true);
});

test("validateCsrf fails when tokens do not match", () => {
  const req = new Request("http://localhost/auth/me", {
    headers: {
      cookie: "csrf_token=token-a",
      "x-csrf-token": "token-b",
    },
  });
  expect(validateCsrf(req)).toBe(false);
});

test("validateCsrf fails when cookie is missing", () => {
  const req = new Request("http://localhost/auth/me", {
    headers: {
      "x-csrf-token": "some-token",
    },
  });
  expect(validateCsrf(req)).toBe(false);
});

test("validateCsrf fails when header is missing", () => {
  const req = new Request("http://localhost/auth/me", {
    headers: {
      cookie: "csrf_token=some-token",
    },
  });
  expect(validateCsrf(req)).toBe(false);
});

test("validateCsrf fails when both are missing", () => {
  const req = new Request("http://localhost/auth/me");
  expect(validateCsrf(req)).toBe(false);
});

// isCsrfExempt

test("isCsrfExempt returns true for /auth/register", () => {
  expect(isCsrfExempt("/auth/register")).toBe(true);
});

test("isCsrfExempt returns true for /auth/login", () => {
  expect(isCsrfExempt("/auth/login")).toBe(true);
});

test("isCsrfExempt returns true for /auth/request-password-reset", () => {
  expect(isCsrfExempt("/auth/request-password-reset")).toBe(true);
});

test("isCsrfExempt returns true for /auth/reset-password", () => {
  expect(isCsrfExempt("/auth/reset-password")).toBe(true);
});

test("isCsrfExempt returns true for /auth/verify-email", () => {
  expect(isCsrfExempt("/auth/verify-email")).toBe(true);
});

test("isCsrfExempt returns true for OAuth callback paths", () => {
  expect(isCsrfExempt("/auth/oauth/github/callback")).toBe(true);
  expect(isCsrfExempt("/auth/oauth/google")).toBe(true);
});

test("isCsrfExempt returns false for protected paths", () => {
  expect(isCsrfExempt("/auth/logout")).toBe(false);
  expect(isCsrfExempt("/auth/me")).toBe(false);
  expect(isCsrfExempt("/trpc/posts.list")).toBe(false);
});

// setCsrfCookie

test("setCsrfCookie returns a token and a cookie containing that token", () => {
  const { token, cookie } = setCsrfCookie(true);
  expect(token.length).toBeGreaterThan(0);
  expect(cookie).toContain(`csrf_token=${token}`);
});

test("setCsrfCookie in production adds Secure flag", () => {
  const { cookie } = setCsrfCookie(false);
  expect(cookie).toContain("Secure");
});

test("setCsrfCookie in dev does not add Secure flag", () => {
  const { cookie } = setCsrfCookie(true);
  expect(cookie).not.toContain("Secure");
});
