interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60 * 1000; // 1 minute
// Hard cap on tracked keys to bound memory under high unique-IP churn.
// When the store is full after pruning expired entries, new IPs are not
// tracked (fail-open) so the rate limiter itself cannot become a DoS vector.
const MAX_KEYS = 50_000;

export function checkRateLimit(ip: string): {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
} {
  const now = Date.now();
  const entry = store.get(ip);

  if (!entry || entry.resetAt < now) {
    // Opportunistically prune all expired entries
    for (const [key, val] of store) {
      if (val.resetAt < now) store.delete(key);
    }
    // Only track new keys up to the hard cap; if still full, skip tracking
    // (fail-open) so the rate limiter cannot be weaponised as a DoS vector
    // via IP address exhaustion.
    if (store.size < MAX_KEYS) {
      store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    }
    return { allowed: true, remaining: MAX_ATTEMPTS - 1, retryAfterMs: 0 };
  }

  entry.count++;

  if (entry.count > MAX_ATTEMPTS) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: entry.resetAt - now,
    };
  }

  return {
    allowed: true,
    remaining: MAX_ATTEMPTS - entry.count,
    retryAfterMs: 0,
  };
}

export function getClientIp(req: Request, trustedProxies: string[]): string {
  const socketIp = req.headers.get("x-tsbase-socket-ip");

  // No socket IP means the request did not arrive through the Bun HTTP server
  // (e.g. direct handler call in tests). Use a per-request random key so that
  // programmatic calls never share a rate-limit bucket with each other.
  // In production the server always injects x-tsbase-socket-ip, so this branch
  // is unreachable for real traffic.
  if (!socketIp) {
    return crypto.randomUUID();
  }

  if (trustedProxies.length > 0 && trustedProxies.includes(socketIp)) {
    // Request arrived from a known proxy — parse X-Forwarded-For right-to-left.
    // Proxies using $proxy_add_x_forwarded_for append the connecting IP, so the
    // rightmost entries are most trustworthy. Attacker-controlled values appear
    // on the left, so taking the first entry is spoofable.
    // We walk right-to-left and return the first hop that is NOT a trusted proxy.
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff.split(",").map((h) => h.trim());
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!trustedProxies.includes(hops[i]!)) {
          return hops[i]!;
        }
      }
    }
    // XFF absent or all hops are trusted proxies — fall back to X-Real-IP or socket IP
    return req.headers.get("x-real-ip") ?? socketIp;
  }

  // No trusted proxy configured, or connection not from a trusted proxy — use socket IP directly
  return socketIp;
}
