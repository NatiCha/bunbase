import type { ResolvedConfig } from "./core/config.ts";

function isOriginAllowed(origin: string, config: ResolvedConfig): boolean {
  if (config.development) return origin.length > 0;
  return config.cors.origins.includes(origin);
}

function corsHeaders(origin: string, config: ResolvedConfig): Headers {
  const headers = new Headers();
  if (!origin || !isOriginAllowed(origin, config)) {
    return headers;
  }

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return headers;
}

export function handleCorsPreflightOrNull(
  req: Request,
  config: ResolvedConfig,
): Response | null {
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

export function addCorsHeaders(
  response: Response,
  req: Request,
  config: ResolvedConfig,
): Response {
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
