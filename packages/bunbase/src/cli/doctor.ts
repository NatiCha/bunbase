import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { DiagnosticsReport } from "../core/diagnostics.ts";

const reportSchema = z.object({
  notes: z.array(z.string().max(1000)).max(20),
  version: z.string().max(64),
  status: z.enum(["pass", "warn", "fail"]),
  checks: z
    .array(
      z.object({
        name: z.string().max(64),
        status: z.enum(["pass", "warn", "fail"]),
        message: z.string().max(1000),
      }),
    )
    .max(100),
});

function readKey(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256) throw new Error("Invalid service key file.");
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}

export async function doctor(options: {
  url?: string;
  keyFile?: string;
}): Promise<DiagnosticsReport> {
  const fail = (message: string): DiagnosticsReport => ({
    notes: [],
    version: "unknown",
    status: "fail",
    checks: [{ name: "connection", status: "fail", message }],
  });
  let url: URL;
  try {
    url = new URL(options.url ?? "http://localhost:3000");
  } catch {
    return fail("Provide a valid server origin with --url.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    return fail(
      "Use an HTTPS origin (HTTP is allowed only on loopback), without credentials, a path, or query parameters.",
    );
  }
  let key = options.keyFile ? undefined : process.env.BUNBASE_SERVICE_KEY;
  if (!key) {
    try {
      if (options.keyFile || loopback) key = readKey(options.keyFile ?? ".bunbase-service-key");
    } catch {
      return fail(
        "Cannot read the service key file. Set BUNBASE_SERVICE_KEY or provide --key-file.",
      );
    }
  }
  if (!key || !/^bb_sk_[^\s]{1,1024}$/.test(key))
    return fail(
      "Set a valid BUNBASE_SERVICE_KEY or provide --key-file. Key values are never printed.",
    );
  try {
    const response = await fetch(new URL("/_admin/api/diagnostics", url), {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403)
      return fail("Service key was rejected by the server.");
    if (response.status !== 200 && response.status !== 503)
      return fail("Diagnostics endpoint unavailable. Run BunBase 0.2.0 or newer at this origin.");
    const result = reportSchema.safeParse(await response.json());
    if (!result.success) return fail("Server returned an invalid diagnostics report.");
    return result.data;
  } catch {
    return fail(
      "Cannot reach diagnostics. Check the origin, TLS, server process, and network; redirects are not followed.",
    );
  }
}
