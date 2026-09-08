// Bundles the kit (imperative helpers + React 19 + ReactDOM + React components) into one classic IIFE script
// that the loader injects right after the UI runtime. Type checking is tsc --noEmit (see package.json).
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {
  entryPoints: [path.join(here, "src/index.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome142"],
  outfile: path.join(here, "dist/index.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  jsx: "automatic",
  legalComments: "inline",
  sourcemap: false,
  minify: false,
  logLevel: "info"
};
if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
