import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production HTML loads a custom application plugin from its working directory", async () => {
  const work = mkdtempSync(join(tmpdir(), "bunbase-plugin-"));
  try {
    await Bun.write(join(work, "bunfig.toml"), '[serve.static]\nplugins = ["./plugin.ts"]\n');
    await Bun.write(
      join(work, "plugin.ts"),
      `export default { name: "smoke-plugin", setup(build) {
        build.onLoad({ filter: /entry\\.js$/ }, () => ({
          contents: "window.pluginReady = true;", loader: "js"
        }));
      } };`,
    );
    await Bun.write(join(work, "entry.js"), 'throw new Error("plugin missing");');
    await Bun.write(
      join(work, "index.html"),
      '<html><head><script type="module" src="./entry.js"></script></head><body>App</body></html>',
    );
    await Bun.write(
      join(work, "check.ts"),
      `import html from "./index.html";
import { frontendRoute } from ${JSON.stringify(new URL("../core/security-headers.ts", import.meta.url).pathname)};
import { resolveConfig } from ${JSON.stringify(new URL("../core/config.ts", import.meta.url).pathname)};
const route = frontendRoute(html, resolveConfig({development: false, cors: {origins: ["https://app.example"]}}));
const page = await route(new Request("https://app.example/nested/path"));
const source = await page.text();
const asset = source.match(/src="([^"]+\\.js)"/)[1];
console.log(await (await route(new Request(new URL(asset, "https://app.example/nested/path")))).text());`,
    );
    const child = Bun.spawn([process.execPath, join(work, "check.ts")], {
      cwd: work,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errors, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(errors).toBe("");
    expect(exit).toBe(0);
    expect(output).toContain("pluginReady");
    expect(output).not.toContain("plugin missing");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
