import type { ResolvedConfig } from "./core/config.ts";

/**
 * Whether CORS should run in strict mode (only reflect configured origins).
 *
 * Driven by `config.secureDefaults` (fail-closed): an unset `NODE_ENV` resolves
 * to strict so a misconfigured production deploy never reflects arbitrary
 * origins with credentials. Only explicit development relaxes this. We fall back
 * to `!config.development` when `secureDefaults` is absent (e.g. a hand-built
 * `ResolvedConfig` in a unit test that predates the field).
 */
function corsStrict(config: ResolvedConfig): boolean {
  return config.secureDefaults ?? !config.development;
}

function isOriginAllowed(origin: string, config: ResolvedConfig): boolean {
  if (origin.length === 0) return false;
  // Strict mode: only reflect explicitly-configured origins. Never reflect an
  // arbitrary origin while also sending Access-Control-Allow-Credentials: true.
  if (corsStrict(config)) return config.cors.origins.includes(origin);
  // Permissive (explicit dev only): reflect any origin for localhost DX.
  return true;
}

function corsHeaders(origin: string, config: ResolvedConfig): Headers {
  const headers = new Headers();
  if (!origin || !isOriginAllowed(origin, config)) {
    return headers;
  }

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");

  const allowHeaders = ["Content-Type", "Authorization", "X-CSRF-Token"];
  if (config.cors.allowHeaders.length > 0) {
    allowHeaders.push(...config.cors.allowHeaders);
  }
  headers.set("Access-Control-Allow-Headers", allowHeaders.join(", "));

  if (config.cors.exposeHeaders.length > 0) {
    headers.set("Access-Control-Expose-Headers", config.cors.exposeHeaders.join(", "));
  }

  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return headers;
}

export function handleCorsPreflightOrNull(req: Request, config: ResolvedConfig): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("origin") ?? "";
  const headers = corsHeaders(origin, config);
  if (!headers.has("Access-Control-Allow-Origin")) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers,
  });
}

export function addCorsHeaders(response: Response, req: Request, config: ResolvedConfig): Response {
  const origin = req.headers.get("origin") ?? "";
  const headers = corsHeaders(origin, config);

  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });

  headers.forEach((value, key) => {
    newResponse.headers.set(key, value);
  });

  return newResponse;
}

export function withCors(
  handler: (req: Request) => Response | Promise<Response>,
  config: ResolvedConfig,
) {
  return async (req: Request): Promise<Response> => {
    const preflight = handleCorsPreflightOrNull(req, config);
    if (preflight) return preflight;

    const response = await handler(req);
    return addCorsHeaders(response, req, config);
  };
}
