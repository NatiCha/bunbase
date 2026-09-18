import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedConfig } from "./config.ts";

/** Match the application's Bun.serve plugin configuration when building HTML ourselves. */
async function frontendPlugins(cwd: string): Promise<Bun.BunPlugin[]> {
  const file = Bun.file(join(cwd, "bunfig.toml"));
  if (!(await file.exists())) return [];
  const config = Bun.TOML.parse(await file.text()) as {
    serve?: { static?: { plugins?: unknown } };
  };
  const plugins = config.serve?.static?.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.some((plugin) => typeof plugin !== "string")) {
    throw new Error("BunBase: serve.static.plugins must be an array of module paths");
  }
  return Promise.all(
    plugins.map(async (specifier: string) => {
      const module = await import(pathToFileURL(Bun.resolveSync(specifier, cwd)).href);
      const plugin = module.default;
      if (!plugin || typeof plugin.name !== "string" || typeof plugin.setup !== "function") {
        throw new Error(`BunBase: invalid frontend plugin: ${specifier}`);
      }
      return plugin as Bun.BunPlugin;
    }),
  );
}

export function browserHeaders(config: ResolvedConfig): Record<string, string> {
  const policy = config.securityHeaders;
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      policy?.permissionsPolicy ?? "camera=(self), microphone=(self), geolocation=(self)",
    [policy?.reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy"]:
      policy?.contentSecurityPolicy ??
      `default-src 'self'; script-src 'self'${config.secureDefaults ? "" : " 'unsafe-inline'"}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'${config.secureDefaults ? "" : " ws: wss:"}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  };
}
export function secureResponse(response: Response, config: ResolvedConfig): Response {
  if (!response) return response; // Successful WebSocket upgrades have no HTTP response.
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(browserHeaders(config)))
    if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Production HTML imports are built once so their responses can carry headers.
 * Development keeps Bun's native HTML route and HMR. */
export function frontendRoute(html: unknown, config: ResolvedConfig): unknown {
  if (typeof html === "function")
    return async (...args: unknown[]) => secureResponse(await html(...args), config);
  if (html instanceof Response) return secureResponse(html, config);
  const bundle = html as Bun.HTMLBundle;
  if (!config.secureDefaults) return html;
  if (bundle.files) {
    return {
      ...bundle,
      files: bundle.files.map((file) => ({
        ...file,
        headers: { ...file.headers, ...browserHeaders(config) },
      })),
    };
  }
  const cwd = process.cwd();
  let built: Promise<{ html: Blob; assets: Map<string, Blob> }> | undefined;
  return async (req: Request) => {
    built ??= (async () => {
      const result = await Bun.build({
        entrypoints: [bundle.index],
        target: "browser",
        publicPath: "/",
        minify: true,
        plugins: await frontendPlugins(cwd),
      });
      if (!result.success)
        throw new Error("BunBase: frontend build failed", { cause: result.logs });
      const assets = new Map(
        result.outputs.map((output) => [`/${output.path.replace(/^\.?\//, "")}`, output]),
      );
      const entry = result.outputs.find(
        (output) => output.kind === "entry-point" && output.path.endsWith(".html"),
      );
      if (!entry) throw new Error("BunBase: frontend HTML entry missing");
      return { html: entry, assets };
    })();
    const output = await built;
    return secureResponse(
      new Response(output.assets.get(new URL(req.url).pathname) ?? output.html),
      config,
    );
  };
}
