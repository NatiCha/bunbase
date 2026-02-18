import { test, expect } from "bun:test";
import { addCorsHeaders, handleCorsPreflightOrNull } from "../cors.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

test("development CORS echoes origin for credentialed requests", () => {
  const config = makeResolvedConfig({ development: true });
  const req = new Request("http://localhost/trpc/posts.list", {
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
  const req = new Request("http://localhost/trpc/posts.list", {
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
