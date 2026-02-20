import index from "./frontend/index.html";

const API_TARGET = "http://localhost:3000";

Bun.serve({
  port: 5173,

  routes: {
    "/": index,
  },

  async fetch(req) {
    const url = new URL(req.url);

    // Proxy API routes to TSBase
    if (
      url.pathname.startsWith("/api") ||
      url.pathname.startsWith("/auth") ||
      url.pathname.startsWith("/files") ||
      url.pathname === "/health"
    ) {
      const target = new URL(url.pathname + url.search, API_TARGET);
      const headers = new Headers(req.headers);
      headers.set("Host", new URL(API_TARGET).host);

      const proxyRes = await fetch(target.toString(), {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        redirect: "manual",
      });

      // Forward response with CORS-friendly headers
      const resHeaders = new Headers(proxyRes.headers);
      return new Response(proxyRes.body, {
        status: proxyRes.status,
        headers: resHeaders,
      });
    }

    // SPA fallback — serve index.html for all other routes
    return new Response(Bun.file("src/frontend/index.html"), {
      headers: { "Content-Type": "text/html" },
    });
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log("Frontend dev server running at http://localhost:5173");
