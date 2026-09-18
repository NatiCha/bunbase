import { resolve } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "admin-ui/index.html")],
  outdir: resolve(import.meta.dir, "dist/admin"),
  publicPath: "/_admin-assets/",
  plugins: [tailwindPlugin],
  minify: true,
});

if (!result.success) {
  console.error("Admin UI build failed:", result.logs);
  process.exit(1);
}
console.log("Admin UI built at dist/admin");
