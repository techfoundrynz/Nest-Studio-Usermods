// Bundles React + ReactDOM with the runtime glue into one classic (IIFE) script the loader can inject.
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {
  entryPoints: [path.join(here, "src/index.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome142"],
  outfile: path.join(here, "dist/react-runtime.js"),
  define: { "process.env.NODE_ENV": '"production"' },
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
