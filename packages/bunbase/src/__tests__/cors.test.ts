import { test, expect } from "bun:test";
import { addCorsHeaders, handleCorsPreflightOrNull, withCors } from "../cors.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

test("development CORS echoes origin for credentialed requests", () => {
  const config = makeResolvedConfig({ development: true });
  const req = new Request("http://localhost/api/posts", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
    },
  });

  const preflight = handleCorsPreflightOrNull(req, config);
  expect(preflight).not.toBeNull();
  expect(preflight?.status).toBe(204);
  expect(preflight?.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:5173",
  );
  expect(preflight?.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  expect(preflight?.headers.get("Vary")).toBe("Origin");
});

test("disallowed production origin is rejected in preflight", () => {
  const config = makeResolvedConfig({
    development: false,
    cors: { origins: ["https://example.com"] },
  });
  const req = new Request("http://localhost/api/posts", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
    },
  });

  const preflight = handleCorsPreflightOrNull(req, config);
  expect(preflight?.status).toBe(403);
});

test("response CORS headers include echoed origin when allowed", () => {
  const config = makeResolvedConfig({ development: true });
  const req = new Request("http://localhost/auth/me", {
    headers: {
      Origin: "http://localhost:5173",
    },
  });

  const response = addCorsHeaders(new Response("OK"), req, config);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:5173",
  );
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
});

// withCors

test("withCors handles OPTIONS preflight and returns preflight response", async () => {
  const config = makeResolvedConfig({ development: true });
  const handler = withCors(() => new Response("body"), config);
  const req = new Request("http://localhost/api/test", {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:5173" },
  });

  const response = await handler(req);
  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:5173",
  );
});

test("withCors injects CORS headers on normal responses", async () => {
  const config = makeResolvedConfig({ development: true });
  const handler = withCors(() => new Response("ok"), config);
  const req = new Request("http://localhost/api/data", {
    headers: { Origin: "http://localhost:5173" },
  });

  const response = await handler(req);
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:5173",
  );
  expect(await response.text()).toBe("ok");
});
