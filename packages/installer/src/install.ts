#!/usr/bin/env tsx
/*
 * Nest Studio user-mod installer.
 *
 *   pnpm run install:app                 interactive menu (install / select mods / build only / uninstall)
 *   pnpm run install:app -- --install    non-interactive install (or re-install after an app update)
 *   pnpm run install:app -- --uninstall  restore the original app.asar
 *   pnpm run install:app -- --build-only build build/app.asar without touching the install (no admin)
 *   flags: --force  --skip-build  --install-root=<dir>  --yes  --allow-untested (see versions.json)
 *   mods:  normally chosen inside Nest Studio (MODS menu -> Enable/disable mods). Fallback when a mod breaks the UI:
 *          --select-mods            interactive picker
 *          --disable-mods=a,b       --enable-mods=a,b       --disable-all-mods   (edit mods.json, no rebuild)
 *   build options (baked into the patched archive; asked interactively when not given):
 *          --devtools / --no-devtools   re-enable Chromium DevTools in the app (F12 toggles them)
 *          --cam-docs / --no-cam-docs   start the CAM service with ENABLE_DOCS=1 (Swagger at 127.0.0.1:9630/docs)
 *          --multi-side / --no-multi-side   allow more than two machining sides (Flip Setup "+" stays available)
 *          --bed-size / --no-bed-size   let the bed-size mod override the machine's travel limits
 *
 * Nest Studio's Electron build only loads code from app.asar (resources\ on Windows, Contents/Resources
 * inside the .app on macOS), so the loader is injected by rebuilding that archive: extract -> patch ->
 * repack -> back up the original as app.asar.orig -> copy into place. Only the final copy needs write
 * access to the install (elevated shell on Windows; App Management permission or sudo on macOS).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import prompts from "prompts";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_MAC = process.platform === "darwin";
const DEFAULT_INSTALL_ROOT = IS_MAC ? "/Applications/Nest Studio.app" : "C:\\Program Files\\nest-studio";
/** Windows keeps resources next to the exe; on macOS they live inside the bundle (--install-root is the .app). */
const resourcesDir = (installRoot: string): string => (IS_MAC ? path.join(installRoot, "Contents", "Resources") : path.join(installRoot, "resources"));
const LOADER_MAIN = path.join(ROOT, "packages", "loader", "dist", "main.js");
const LOADER_PRELOAD = path.join(ROOT, "packages", "loader", "dist", "preload.js");
const BUILD_DIR = path.join(ROOT, "build");
const STAGING_DIR = path.join(BUILD_DIR, "app");
const PACKED_ASAR = path.join(BUILD_DIR, "app.asar");
const STAMP_FILE = path.join(BUILD_DIR, "stamp.json");
/** Read by the loader so the MODS panel can show which build options the installed archive carries. */
const FLAGS_FILE = path.join(BUILD_DIR, "flags.json");

const MAIN_MARKER = "/* NEST-USERMOD-MAIN */";
const PRELOAD_BEGIN = "// ==== NEST-USERMOD-PRELOAD-BEGIN ====";
const PRELOAD_END = "// ==== NEST-USERMOD-PRELOAD-END ====";

/* ----------------------------------------------------------- build options */
interface BuildOption {
  id: string;
  cli: string;
  label: string;
  description: string;
  /** Idempotent text transforms; apply() must leave a marker so revert() can undo it. */
  apply(source: string): string;
  revert(source: string): string;
  marker: string;
  /** "main" (default): out/main/index.js. "renderer": every out/renderer/assets file matching `assets`. */
  target?: "renderer";
  assets?: RegExp;
  /** Renderer options patch several sites; all of them must carry the marker for the option to count as applied. */
  expectedMarkers?: number;
}
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/* Bed size override: the app's hard-coded travel limits and work-platform size become lookups of a global
 * the loader's preload fills in (see the bedSize build option below). */
const BED_MARKER = "/* NEST-USERMOD-BED */";
const LIT_UPPER = `{\n  X: { min: -238, max: 0 },\n  Y: { min: -200, max: 0 },\n  Z: { min: -123, max: 0 }\n}`;
const PATCHED_UPPER = `{ ${BED_MARKER}\n  get X() { return globalThis.__usermodBed?.X ?? { min: -238, max: 0 }; },\n  get Y() { return globalThis.__usermodBed?.Y ?? { min: -200, max: 0 }; },\n  get Z() { return globalThis.__usermodBed?.Z ?? { min: -123, max: 0 }; }\n}`;
const LIT_LOWER = `{\n  x: { min: -238, max: 0 },\n  y: { min: -200, max: 0 },\n  z: { min: -123, max: 0 }\n}`;
const PATCHED_LOWER = `{ ${BED_MARKER}\n  get x() { return globalThis.__usermodBed?.X ?? { min: -238, max: 0 }; },\n  get y() { return globalThis.__usermodBed?.Y ?? { min: -200, max: 0 }; },\n  get z() { return globalThis.__usermodBed?.Z ?? { min: -123, max: 0 }; }\n}`;
const LIT_PLATFORM = "const EDITOR_WORK_PLATFORM_SIZE = 225;";
const PATCHED_PLATFORM = `const EDITOR_WORK_PLATFORM_SIZE = Number(globalThis.__usermodBedPlatform) > 0 ? Number(globalThis.__usermodBedPlatform) : 225; ${BED_MARKER}`;
const BUILD_OPTIONS: BuildOption[] = [
  {
    id: "devtools",
    cli: "devtools",
    label: "Chromium DevTools",
    description: "The app ships OPEN_DEV_TOOLS=false and closes DevTools as soon as they open. F12 (app-tools) toggles them.",
    marker: "/* NEST-USERMOD-DEVTOOLS */",
    // Both replacements must stay valid JavaScript: notes live INSIDE the comment.
    apply: (s) =>
      s
        .replace("const OPEN_DEV_TOOLS = false;", "const OPEN_DEV_TOOLS = true; /* NEST-USERMOD-DEVTOOLS */")
        .replace(/^(\s*)webContents\.closeDevTools\(\);/m, "$1void 0; /* NEST-USERMOD-DEVTOOLS closeDevTools() disabled */"),
    revert: (s) =>
      s
        .replace("const OPEN_DEV_TOOLS = true; /* NEST-USERMOD-DEVTOOLS */", "const OPEN_DEV_TOOLS = false;")
        .replace(/^(\s*)void 0; \/\* NEST-USERMOD-DEVTOOLS closeDevTools\(\) disabled \*\//m, "$1webContents.closeDevTools();")
  },
  {
    id: "camDocs",
    cli: "cam-docs",
    label: "CAM API docs (Swagger)",
    description: "Starts the CAM service with ENABLE_DOCS=1 so http://127.0.0.1:9630/docs works without launching from a shell.",
    marker: "/* NEST-USERMOD-CAMDOCS */",
    apply: (s) => s.replace("env: { ...process.env },", 'env: { ...process.env, ENABLE_DOCS: "1" }, /* NEST-USERMOD-CAMDOCS */'),
    revert: (s) => s.replace('env: { ...process.env, ENABLE_DOCS: "1" }, /* NEST-USERMOD-CAMDOCS */', "env: { ...process.env },")
  },
  {
    /*
     * The project model (saveCoordsSystemList), toolpath generation, preview face switcher and the machining
     * queue all handle any number of sides already; the app only hides the Flip Setup "+" button once a second
     * side exists and lays flip platforms out for exactly one RX and one RY position. These edits lift the
     * button cap, tile extra platforms of the same direction further out, keep the direction badge for the
     * last side, and make the generation order stable when several sides share a rank.
     */
    id: "multiSide",
    cli: "multi-side",
    label: "More than two machining sides",
    description: "Keeps the Flip Setup \"+\" button after the second side and tiles extra flip platforms so any number of sides can be set up, generated, previewed and machined in sequence.",
    marker: "/* NEST-USERMOD-MULTISIDE */",
    target: "renderer",
    assets: /^(PreparePageContent|engine-3d|FullApp)-.*\.js$/,
    expectedMarkers: 9,
    apply: (s) =>
      s
        // Prepare page: the "+" button and the direction badge.
        .replace('items.length === 1 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Tooltip, { title: t("common.message.createNewSide")', 'items.length >= 1 /* NEST-USERMOD-MULTISIDE */ ? /* @__PURE__ */ jsxRuntimeExports.jsx(Tooltip, { title: t("common.message.createNewSide")')
        .replace("coordsList.length !== 2) {", "coordsList.length < 2) { /* NEST-USERMOD-MULTISIDE */")
        .replace("const direction = coordsList[1]?.flipDirection;", "const direction = coordsList[coordsList.length - 1]?.flipDirection; /* NEST-USERMOD-MULTISIDE */")
        // 3D engine: flip platforms get a slot per direction so a third side does not land on the second.
        .replace("function getFlipPlatformOffset(direction, dimensions) {", "function getFlipPlatformOffset(direction, dimensions, slot = 0) { /* NEST-USERMOD-MULTISIDE */")
        .replace(/(function getFlipPlatformOffset\(direction, dimensions, slot = 0\) \{ \/\* NEST-USERMOD-MULTISIDE \*\/\s*const spacing = resolveFlipPlatformSpacing\(dimensions\))(;)/, "$1 * (slot + 1)$2")
        .replace("const offset = getFlipPlatformOffset(spec.flipDirection, dimensions);", "const slot = specs.slice(0, specs.indexOf(spec)).filter((other) => other.flipDirection === spec.flipDirection).length; const offset = getFlipPlatformOffset(spec.flipDirection, dimensions, slot); /* NEST-USERMOD-MULTISIDE */")
        .replace(/flipDirection: spec\.flipDirection,(\s*)platformGroup,/, "flipDirection: spec.flipDirection, slot, /* NEST-USERMOD-MULTISIDE */$1platformGroup,")
        .replace("const offset = getFlipPlatformOffset(entry.flipDirection, dimensions);", "const offset = getFlipPlatformOffset(entry.flipDirection, dimensions, entry.slot ?? 0); /* NEST-USERMOD-MULTISIDE */")
        .replace(/getFlipPlatformOffset\(\s*bottomEntry\.flipDirection,\s*stock\.stockDimensions\s*\)/, "getFlipPlatformOffset(bottomEntry.flipDirection, stock.stockDimensions, bottomEntry.slot ?? 0) /* NEST-USERMOD-MULTISIDE */")
        // App: deterministic generation order when several sides share a rank (list order wins).
        .replace("rankCoordsForGeneration(left) - rankCoordsForGeneration(right));", "rankCoordsForGeneration(left) - rankCoordsForGeneration(right) || list2.indexOf(left) - list2.indexOf(right)); /* NEST-USERMOD-MULTISIDE */"),
    revert: (s) =>
      s
        .replace('items.length >= 1 /* NEST-USERMOD-MULTISIDE */ ? /* @__PURE__ */ jsxRuntimeExports.jsx(Tooltip, { title: t("common.message.createNewSide")', 'items.length === 1 ? /* @__PURE__ */ jsxRuntimeExports.jsx(Tooltip, { title: t("common.message.createNewSide")')
        .replace("coordsList.length < 2) { /* NEST-USERMOD-MULTISIDE */", "coordsList.length !== 2) {")
        .replace("const direction = coordsList[coordsList.length - 1]?.flipDirection; /* NEST-USERMOD-MULTISIDE */", "const direction = coordsList[1]?.flipDirection;")
        .replace(/(function getFlipPlatformOffset\(direction, dimensions, slot = 0\) \{ \/\* NEST-USERMOD-MULTISIDE \*\/\s*const spacing = resolveFlipPlatformSpacing\(dimensions\)) \* \(slot \+ 1\);/, "$1;")
        .replace("function getFlipPlatformOffset(direction, dimensions, slot = 0) { /* NEST-USERMOD-MULTISIDE */", "function getFlipPlatformOffset(direction, dimensions) {")
        .replace("const slot = specs.slice(0, specs.indexOf(spec)).filter((other) => other.flipDirection === spec.flipDirection).length; const offset = getFlipPlatformOffset(spec.flipDirection, dimensions, slot); /* NEST-USERMOD-MULTISIDE */", "const offset = getFlipPlatformOffset(spec.flipDirection, dimensions);")
        .replace(/flipDirection: spec\.flipDirection, slot, \/\* NEST-USERMOD-MULTISIDE \*\/(\s*)platformGroup,/, "flipDirection: spec.flipDirection,$1platformGroup,")
        .replace("const offset = getFlipPlatformOffset(entry.flipDirection, dimensions, entry.slot ?? 0); /* NEST-USERMOD-MULTISIDE */", "const offset = getFlipPlatformOffset(entry.flipDirection, dimensions);")
        .replace("getFlipPlatformOffset(bottomEntry.flipDirection, stock.stockDimensions, bottomEntry.slot ?? 0) /* NEST-USERMOD-MULTISIDE */", "getFlipPlatformOffset(bottomEntry.flipDirection, stock.stockDimensions)")
        .replace("rankCoordsForGeneration(left) - rankCoordsForGeneration(right) || list2.indexOf(left) - list2.indexOf(right)); /* NEST-USERMOD-MULTISIDE */", "rankCoordsForGeneration(left) - rankCoordsForGeneration(right));")
  },
  {
    /*
     * The renderer hard-codes the machine envelope (X -238, Y -200, Z -123) in two chunks: FullApp checks a
     * program's bounds against it and limits continuous jog, DevicePage checks travel with the workpiece
     * offset applied, and engine-3d draws a fixed 225 mm work platform. This turns those constants into
     * lookups of globalThis.__usermodBed, which the loader's preload sets from the bed-size mod's settings
     * before any app code runs; without the mod the app's own numbers are used.
     */
    id: "bedSize",
    cli: "bed-size",
    label: "Bed size override",
    description: "Lets the bed-size mod tell the app how much travel the machine really has, instead of the built-in 238 x 200 x 123 mm.",
    marker: BED_MARKER,
    target: "renderer",
    assets: /^(FullApp|DevicePage|engine-3d)-.*\.js$/,
    expectedMarkers: 4,
    apply: (s) => s.split(LIT_UPPER).join(PATCHED_UPPER).split(LIT_LOWER).join(PATCHED_LOWER).replace(LIT_PLATFORM, PATCHED_PLATFORM),
    revert: (s) => s.split(PATCHED_UPPER).join(LIT_UPPER).split(PATCHED_LOWER).join(LIT_LOWER).replace(PATCHED_PLATFORM, LIT_PLATFORM)
  }
];
const countMarkers = (source: string, marker: string): number => source.split(marker).length - 1;
type Flags = Record<string, boolean>;

interface Options {
  action: "menu" | "install" | "uninstall" | "build-only" | "select-mods";
  force: boolean;
  skipBuild: boolean;
  yes: boolean;
  allowUntested: boolean;
  installRoot: string;
  enableMods: string[];
  disableMods: string[];
  disableAllMods: boolean;
  /** Build options given on the command line; undefined = ask (TTY) or keep the previous build's value. */
  flags: Record<string, boolean | undefined>;
}
interface Stamp {
  sourceSha: string;
  packedSha: string;
  builtAt: string;
  flags?: Flags;
}
/* ------------------------------------------------------------------ output */
const color = (code: number, text: string): string => (process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const step = (text: string): void => console.log(color(36, "==> ") + text);
const ok = (text: string): void => console.log(color(32, text));
const warn = (text: string): void => console.log(color(33, `WARNING: ${text}`));
class InstallError extends Error {}
const fail = (text: string): never => {
  throw new InstallError(text);
};

/* -------------------------------------------------------------------- args */
function parseArgs(argv: string[]): Options {
  const options: Options = {
    action: "menu",
    force: false,
    skipBuild: false,
    yes: false,
    allowUntested: false,
    installRoot: DEFAULT_INSTALL_ROOT,
    enableMods: [],
    disableMods: [],
    disableAllMods: false,
    flags: {}
  };
  const list = (value: string): string[] => value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const arg of argv) {
    const option = BUILD_OPTIONS.find((o) => arg === `--${o.cli}` || arg === `--no-${o.cli}`);
    if (option) options.flags[option.id] = arg === `--${option.cli}`;
    else if (arg === "--install") options.action = "install";
    else if (arg === "--uninstall") options.action = "uninstall";
    else if (arg === "--build-only") options.action = "build-only";
    else if (arg === "--select-mods") options.action = "select-mods";
    else if (arg.startsWith("--enable-mods=")) options.enableMods.push(...list(arg.slice("--enable-mods=".length)));
    else if (arg.startsWith("--disable-mods=")) options.disableMods.push(...list(arg.slice("--disable-mods=".length)));
    else if (arg === "--disable-all-mods") options.disableAllMods = true;
    else if (arg === "--allow-untested") options.allowUntested = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg.startsWith("--install-root=")) options.installRoot = arg.slice("--install-root=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]!.replace(/^#!.*\r?\n/, "").replace(/^\/\*\s*/, "").replace(/^ \* ?/gm, ""));
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  return options;
}

/* ----------------------------------------------------------------- helpers */
function sha256(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let n: number;
  while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, n));
  fs.closeSync(fd);
  return hash.digest("hex").toUpperCase();
}
function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
function runningNestProcesses(): string[] {
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/NH", "/FO", "CSV"], { encoding: "utf8" }).stdout ?? "";
    return out
      .split(/\r?\n/)
      .filter((line) => /^"(nest-studio\.exe|Nest Studio Service\.exe)"/i.test(line))
      .map((line) => line.split('","')[0]!.replace(/^"/, ""));
  }
  if (IS_MAC) {
    // Matches the app, its helpers and the CAM service, which all run from inside the bundle.
    const out = spawnSync("pgrep", ["-fl", "Nest Studio.app/Contents"], { encoding: "utf8" }).stdout ?? "";
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const executable = line.replace(/^\d+\s+/, "").split(" -")[0]!;
        return /\/([^/]+)$/.exec(executable)?.[1] ?? "Nest Studio";
      });
  }
  return [];
}
function assertClosed(): void {
  const running = runningNestProcesses();
  if (running.length) fail(`Nest Studio is running (${[...new Set(running)].join(", ")}). Quit it fully first.`);
}
function assertWritable(dir: string): void {
  const probe = path.join(dir, ".usermod-write-probe");
  try {
    fs.writeFileSync(probe, "probe");
    fs.unlinkSync(probe);
  } catch {
    fail(
      IS_MAC
        ? `cannot write to ${dir}. Grant your terminal App Management access (System Settings > Privacy & Security > App Management) or re-run with sudo.`
        : `cannot write to ${dir}. Run this from an elevated (Administrator) terminal.`
    );
  }
}
function runPnpm(args: string[]): void {
  // When launched via `pnpm run`, npm_execpath points at pnpm's JS entry: run it with node directly so
  // no shell is involved. Fall back to the shell only when invoked some other way.
  const execPath = process.env.npm_execpath;
  const result =
    execPath && /\.(m?js|cjs)$/i.test(execPath)
      ? spawnSync(process.execPath, [execPath, ...args], { cwd: ROOT, stdio: "inherit" })
      : spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) fail(`pnpm ${args.join(" ")} failed`);
}
function ensureBuilt(options: Options): void {
  if (options.skipBuild) return;
  step("building workspace (pnpm run build)");
  runPnpm(["run", "build"]);
  if (!fs.existsSync(LOADER_MAIN) || !fs.existsSync(LOADER_PRELOAD)) fail(`loader build output missing at ${path.dirname(LOADER_MAIN)}`);
}
async function loadAsar(): Promise<typeof import("@neststudio-usermods/asar")> {
  // Imported lazily so a fresh clone can build the workspace before the asar package exists.
  return import("@neststudio-usermods/asar");
}

/* -------------------------------------------------------------------- mods */
/* Normally chosen inside Nest Studio (MODS -> Enable/disable mods). The CLI is the fallback when a mod breaks the UI. */
const MODS_DIR = path.join(ROOT, "mods");
const CONFIG_FILE = path.join(ROOT, "mods.json");
interface ModInfo {
  name: string;
  description: string;
  kinds: string[];
  core: boolean;
  enabled: boolean;
}
const CONFIG_DEFAULT_FILE = path.join(ROOT, "mods.default.json");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function readConfigFile(): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(CONFIG_DEFAULT_FILE)) fs.copyFileSync(CONFIG_DEFAULT_FILE, CONFIG_FILE);
  const raw = readJson<unknown>(CONFIG_FILE, {});
  return isRecord(raw) ? raw : {};
}
function readEnabled(file: Record<string, unknown>): string[] {
  return Array.isArray(file.enabled) ? file.enabled.filter((d): d is string => typeof d === "string") : [];
}
function discoverMods(enabled: string[]): ModInfo[] {
  if (!fs.existsSync(MODS_DIR)) return [];
  const mods: ModInfo[] = [];
  for (const entry of fs.readdirSync(MODS_DIR)) {
    const pkg = readJson<{ name?: string; description?: string; usermod?: Record<string, unknown> }>(path.join(MODS_DIR, entry, "package.json"), {});
    if (!pkg.usermod) continue;
    const m = pkg.usermod;
    const name = typeof m.name === "string" ? m.name : (pkg.name ?? entry).replace(/^@[^/]+\//, "");
    const core = m.core === true;
    const kinds = (["postprocessor", "main", "ui"] as const).filter((k) => typeof m[k] === "string");
    mods.push({ name, description: String(m.description ?? pkg.description ?? ""), kinds, core, enabled: core || enabled.includes(name) });
  }
  return mods.sort((a, b) => Number(b.core) - Number(a.core) || a.name.localeCompare(b.name, "en"));
}
function writeEnabled(names: string[]): void {
  const file = readConfigFile();
  file.enabled = [...new Set(names)].sort();
  if (typeof file.settings !== "object" || file.settings === null) file.settings = {};
  writeText(CONFIG_FILE, JSON.stringify(file, null, 2) + "\n");
  ok(`mods.json updated: enabled = ${(file.enabled as string[]).join(", ") || "(none)"}`);
  console.log("Post-processors apply after 'Reload post-processors' in the MODS panel; UI/main mods after an app restart.");
}
function applyModFlags(options: Options): boolean {
  if (!options.disableAllMods && !options.enableMods.length && !options.disableMods.length) return false;
  const file = readConfigFile();
  const mods = discoverMods(readEnabled(file));
  const known = new Set(mods.filter((m) => !m.core).map((m) => m.name));
  for (const n of [...options.enableMods, ...options.disableMods]) if (!known.has(n)) fail(`unknown mod: ${n} (known: ${[...known].join(", ")})`);
  let enabled = new Set(options.disableAllMods ? [] : mods.filter((m) => m.enabled && !m.core).map((m) => m.name));
  for (const n of options.enableMods) enabled.add(n);
  for (const n of options.disableMods) enabled.delete(n);
  writeEnabled([...enabled]);
  return true;
}
async function selectMods(): Promise<void> {
  const mods = discoverMods(readEnabled(readConfigFile()));
  if (!mods.length) fail(`no mods found under ${MODS_DIR}`);
  const answer = await prompts({
    type: "multiselect",
    name: "enabled",
    message: "Enabled mods (space toggles, enter confirms; core mods always load)",
    instructions: false,
    choices: mods.map((m) => ({ title: `${m.name}  ${color(90, `[${m.kinds.join("+")}] ${m.description}`)}`, value: m.name, selected: m.enabled, disabled: m.core })),
    // keep core mods listed (disabled = not toggleable) but never write them to the enabled list
  });
  if (!Array.isArray(answer.enabled)) return; // cancelled
  writeEnabled((answer.enabled as string[]).filter((n) => !mods.find((m) => m.name === n)?.core));
}

/* ----------------------------------------------------------- build options */
async function resolveFlags(options: Options, stamp: Stamp | null): Promise<Flags> {
  const flags: Flags = {};
  for (const o of BUILD_OPTIONS) flags[o.id] = options.flags[o.id] ?? stamp?.flags?.[o.id] ?? false;
  const unspecified = BUILD_OPTIONS.filter((o) => options.flags[o.id] === undefined);
  if (unspecified.length && !options.yes && process.stdin.isTTY) {
    const answer = await prompts({
      type: "multiselect",
      name: "on",
      message: "Build options to bake into the patched app (space toggles, enter confirms)",
      instructions: false,
      choices: unspecified.map((o) => ({ title: `${o.label}  ${color(90, o.description)}`, value: o.id, selected: flags[o.id] }))
    });
    if (Array.isArray(answer.on)) for (const o of unspecified) flags[o.id] = (answer.on as string[]).includes(o.id);
  }
  return flags;
}
function patchBuildOptions(file: string, flags: Flags): void {
  let source = fs.readFileSync(file, "utf8");
  const original = source;
  for (const o of BUILD_OPTIONS) {
    if (o.target === "renderer") continue;
    const on = flags[o.id] === true;
    source = on ? o.apply(source) : o.revert(source);
    const present = source.includes(o.marker);
    if (on && !present) warn(`${o.label}: anchors not found in out/main/index.js (app version changed?); option not applied`);
    step(`${o.label}: ${on && present ? "ON" : "off"}`);
  }
  if (source !== original) fs.writeFileSync(file, source, "utf8");
  assertParses(file);
}
/** Renderer-side build options: the same idempotent transforms, run over every matching asset chunk. */
function patchRendererOptions(assetsDir: string, flags: Flags): void {
  const names = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  for (const o of BUILD_OPTIONS) {
    if (o.target !== "renderer" || !o.assets) continue;
    const on = flags[o.id] === true;
    let markers = 0;
    for (const name of names.filter((n) => o.assets!.test(n))) {
      const file = path.join(assetsDir, name);
      const source = fs.readFileSync(file, "utf8");
      const next = on ? o.apply(source) : o.revert(source);
      if (next !== source) {
        fs.writeFileSync(file, next, "utf8");
        assertParses(file);
      }
      markers += countMarkers(next, o.marker);
    }
    const expected = o.expectedMarkers ?? 1;
    if (on && markers < expected) warn(`${o.label}: only ${markers} of ${expected} anchors found in the renderer chunks (app version changed?); option incomplete`);
    if (!on && markers > 0) warn(`${o.label}: ${markers} marker(s) could not be reverted`);
    step(`${o.label}: ${on && markers >= expected ? "ON" : on ? "PARTIAL" : "off"}`);
  }
}
/** A syntax error in the patched main script means the app will not start at all: check before packing. */
function assertParses(file: string): void {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) fail(`patched ${path.basename(file)} does not parse:\n${(result.stderr || result.stdout).trim()}`);
}

/* --------------------------------------------------------- version policy */
interface VersionsFile {
  tested: string[];
  notes?: Record<string, string>;
}
async function checkVersion(version: string, options: Options): Promise<void> {
  const versions = readJson<VersionsFile>(path.join(ROOT, "versions.json"), { tested: [] });
  if (versions.tested.includes(version)) {
    step(`Nest Studio ${version} is a tested version`);
    return;
  }
  warn(`Nest Studio ${version} has not been verified with this loader (tested: ${versions.tested.join(", ") || "none"}).`);
  console.log("    Patches are anchor-based and usually survive updates; the parse check and anchor warnings above are the safety net.");
  if (options.allowUntested) return;
  if (!options.yes && process.stdin.isTTY) {
    const answer = await prompts({ type: "confirm", name: "go", message: `Continue with untested Nest Studio ${version}?`, initial: false });
    if (answer.go === true) return;
  }
  fail(`refusing to patch untested version ${version}; pass --allow-untested to override, or add it to versions.json after verifying`);
}

/* ------------------------------------------------------------------- patch */
function patchMain(file: string): void {
  const source = fs.readFileSync(file, "utf8");
  const inject = `${MAIN_MARKER} try { require(process.env.NEST_MOD_LOADER || ${JSON.stringify(LOADER_MAIN)}); } catch (e) { console.error("[usermod] loader failed to start", e); }`;
  let updated: string;
  if (source.includes(MAIN_MARKER)) {
    updated = source.replace(new RegExp(`${escapeRegExp(MAIN_MARKER)}[^\r\n]*`), () => inject);
    step(updated === source ? "main process already patched" : "updated main process loader path");
  } else {
    updated = source.startsWith('"use strict";') ? `"use strict";\n${inject}${source.slice('"use strict";'.length)}` : `${inject}\n${source}`;
    step("patched main process");
  }
  if (updated !== source) fs.writeFileSync(file, updated, "utf8");
}
function patchPreload(file: string): void {
  const compiled = fs.readFileSync(LOADER_PRELOAD, "utf8");
  const begin = compiled.indexOf(PRELOAD_BEGIN);
  if (begin < 0) fail(`${LOADER_PRELOAD} lacks the ${PRELOAD_BEGIN} marker`);
  const block = `${compiled.slice(begin).trimEnd()}\n${PRELOAD_END}`;
  const source = fs.readFileSync(file, "utf8");
  const bi = source.indexOf(PRELOAD_BEGIN);
  const ei = source.indexOf(PRELOAD_END);
  let updated: string;
  if (bi >= 0 && ei > bi) {
    updated = source.slice(0, bi) + block + source.slice(ei + PRELOAD_END.length);
    step("refreshed preload bridge block");
  } else {
    updated = `${source.trimEnd()}\n${block}\n`;
    step("appended preload bridge block");
  }
  fs.writeFileSync(file, updated, "utf8");
}
/**
 * Exposes the app's three.js SceneManager instances (globalThis.__usermodSceneManagers) for view mods, and the
 * preview's toolpath simulation runtime (globalThis.__usermodSimRuntimes) for cutter/simulation mods.
 */
const SCENE_MARKER = "/* NEST-USERMOD-SCENE */";
const SIM_MARKER = "/* NEST-USERMOD-SIMRUNTIME */";
function patchScene(assetsDir: string): void {
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^engine-3d-.*\.js$/.test(f)) : [];
  if (!files.length) {
    warn("engine-3d chunk not found; 3D view mods will be inactive");
    return;
  }
  for (const name of files) {
    const file = path.join(assetsDir, name);
    let source = fs.readFileSync(file, "utf8");
    const original = source;
    // SceneManager constructor: right after it saves the initial camera state.
    const sceneAnchor = "this.cameraController.saveState();";
    if (!source.includes(SCENE_MARKER)) {
      if (source.includes(sceneAnchor)) source = source.replace(sceneAnchor, `${sceneAnchor} (globalThis.__usermodSceneManagers ??= new Set()).add(this); ${SCENE_MARKER}`);
      else warn(`3D scene anchor not found in ${name}; view mods will be inactive`);
    }
    // EditorToolpathSimulationRuntime constructor: the statement hiding the cutter, followed by resetRotary().
    if (!source.includes(SIM_MARKER)) {
      const simAnchor = /(this\.cuttingTool\.root\.visible = false;)(\s*\}\s*\}\s*resetRotary\(\) \{)/;
      if (simAnchor.test(source)) source = source.replace(simAnchor, `$1 (globalThis.__usermodSimRuntimes ??= new Set()).add(this); ${SIM_MARKER}$2`);
      else warn(`simulation runtime anchor not found in ${name}; cutter mods will be inactive`);
    }
    if (source !== original) {
      fs.writeFileSync(file, source, "utf8");
      assertParses(file);
      step(`patched 3D scene access (${name})`);
    } else step(`3D scene access already patched (${name})`);
  }
}
function patchCsp(file: string): void {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes("script-src 'self' file:")) step("CSP already allows file: scripts");
  else if (source.includes("script-src 'self';")) {
    fs.writeFileSync(file, source.replace("script-src 'self';", "script-src 'self' file:;"), "utf8");
    step("patched CSP script-src in index.html");
  } else warn("could not find script-src 'self'; in index.html - UI mods may be blocked by CSP");
}

/** Read the patches back out of the finished archive so a stale or skipped patch can never be installed. */
function verifyPacked(asarLib: typeof import("@neststudio-usermods/asar"), archive: string, flags: Flags): void {
  const read = (rel: string): string => asarLib.readEntry(archive, rel).toString("utf8");
  const main = read("out/main/index.js");
  const problems: string[] = [];
  if (!main.includes(MAIN_MARKER)) problems.push("loader require missing from out/main/index.js");
  if (!main.includes(JSON.stringify(LOADER_MAIN))) problems.push("loader path in out/main/index.js does not match this repo");
  for (const o of BUILD_OPTIONS) {
    if (!flags[o.id]) continue;
    if (o.target === "renderer" && o.assets) {
      const chunks = asarLib.list(archive).filter((e) => o.assets!.test(path.posix.basename(e.path)) && e.path.startsWith("out/renderer/assets/"));
      const markers = chunks.reduce((sum, e) => sum + countMarkers(read(e.path), o.marker), 0);
      if (markers < (o.expectedMarkers ?? 1)) problems.push(`${o.label} requested but only ${markers} of ${o.expectedMarkers ?? 1} patch sites present`);
    } else if (!main.includes(o.marker)) problems.push(`${o.label} requested but not present`);
  }
  const preload = read("out/preload/index.js");
  if (!preload.includes(PRELOAD_BEGIN) || !preload.includes(PRELOAD_END)) problems.push("preload bridge block missing");
  if (!read("out/renderer/index.html").includes("script-src 'self' file:")) problems.push("CSP file: allowance missing");
  const engine = asarLib.list(archive).find((e) => /^out\/renderer\/assets\/engine-3d-.*\.js$/.test(e.path));
  if (engine) {
    const chunk = read(engine.path);
    if (!chunk.includes(SCENE_MARKER)) warn("3D scene access marker missing from the engine chunk; view mods will report 'not patched in'");
    if (!chunk.includes(SIM_MARKER)) warn("simulation runtime marker missing from the engine chunk; tool-visual will be inactive");
  }
  if (problems.length) fail(`packed archive failed verification:\n  - ${problems.join("\n  - ")}`);
  step("verified patches in the packed archive");
}

/* ----------------------------------------------------------------- install */
async function install(options: Options, buildOnly: boolean): Promise<void> {
  const resources = resourcesDir(options.installRoot);
  const asar = path.join(resources, "app.asar");
  const asarOrig = path.join(resources, "app.asar.orig");
  if (!fs.existsSync(asar)) fail(`app.asar not found at ${asar} (use --install-root=<dir>${IS_MAC ? ", pointing at the .app bundle" : ""})`);
  ensureBuilt(options);
  const asarLib = await loadAsar();

  // Content-based detection: a patched archive is never treated as the original.
  const stamp = readJson<Stamp | null>(STAMP_FILE, null);
  const currentSha = sha256(asar);
  const installedMain = asarLib.readEntry(asar, "out/main/index.js").toString("utf8");
  const installedPatched = installedMain.includes(MAIN_MARKER);
  const loaderMatch = /NEST_MOD_LOADER \|\| ("(?:[^"\\]|\\.)*")/.exec(installedMain);
  const installedLoader = installedPatched && loaderMatch ? (JSON.parse(loaderMatch[1]!) as string) : null;
  const loaderMatches = installedLoader !== null && installedLoader.toLowerCase() === LOADER_MAIN.toLowerCase();
  const flags = await resolveFlags(options, stamp);
  const flagsMatch = BUILD_OPTIONS.every((o) => (stamp?.flags?.[o.id] ?? false) === flags[o.id]);
  if (!buildOnly && stamp && stamp.packedSha === currentSha && loaderMatches && flagsMatch && !options.force) {
    ok(`Installed app.asar already carries this loader and these build options (sha ${currentSha.slice(0, 12)}). Use --force to rebuild.`);
    return;
  }
  let sourceAsar = asar;
  if (installedPatched) {
    if (!fs.existsSync(asarOrig)) fail(`app.asar is already patched (loader: ${installedLoader}) but ${asarOrig} is missing; cannot rebuild safely`);
    sourceAsar = asarOrig;
    if (installedLoader && !loaderMatches) step(`installed loader path is ${installedLoader}; repointing to ${LOADER_MAIN}`);
  }
  const sourceSha = sha256(sourceAsar);
  step(`source archive: ${sourceAsar} (sha ${sourceSha.slice(0, 12)})`);

  const needExtract = options.force || !fs.existsSync(path.join(STAGING_DIR, "package.json")) || stamp?.sourceSha !== sourceSha;
  if (needExtract) {
    if (fs.existsSync(STAGING_DIR)) {
      step("removing previous staging dir");
      fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    }
    step(`extracting to ${STAGING_DIR}`);
    const r = asarLib.extract(sourceAsar, STAGING_DIR);
    for (const missing of r.missingUnpacked) warn(`unpacked file missing: ${missing}`);
    console.log(`    ${r.packed} packed + ${r.unpacked} unpacked files, ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
  } else step("staging dir is current; skipping extraction");
  const version = readJson<{ version?: string }>(path.join(STAGING_DIR, "package.json"), {}).version ?? "?";
  await checkVersion(version, options);

  const mainFile = path.join(STAGING_DIR, "out", "main", "index.js");
  patchMain(mainFile);
  patchBuildOptions(mainFile, flags);
  patchPreload(path.join(STAGING_DIR, "out", "preload", "index.js"));
  patchCsp(path.join(STAGING_DIR, "out", "renderer", "index.html"));
  patchScene(path.join(STAGING_DIR, "out", "renderer", "assets"));
  patchRendererOptions(path.join(STAGING_DIR, "out", "renderer", "assets"), flags);

  step("repacking archive");
  const packed = asarLib.pack(sourceAsar, STAGING_DIR, PACKED_ASAR);
  console.log(`    ${packed.files} files, ${(packed.payloadBytes / 1024 / 1024).toFixed(1)} MB payload -> ${PACKED_ASAR}`);
  verifyPacked(asarLib, PACKED_ASAR, flags);
  const packedSha = sha256(PACKED_ASAR);
  writeText(STAMP_FILE, JSON.stringify({ sourceSha, packedSha, builtAt: new Date().toISOString(), flags } satisfies Stamp, null, 2));
  if (buildOnly) {
    ok(`Built ${PACKED_ASAR} for Nest Studio ${version} (not installed).`);
    return;
  }

  assertClosed();
  assertWritable(resources);
  if (sourceAsar === asar) {
    step(`backing up original to ${asarOrig}`);
    fs.copyFileSync(asar, asarOrig);
  }
  step("installing patched archive");
  fs.copyFileSync(PACKED_ASAR, asar);
  writeText(FLAGS_FILE, JSON.stringify({ appVersion: version, installedAt: new Date().toISOString(), flags }, null, 2));
  const staleDir = path.join(resources, "app");
  if (fs.existsSync(path.join(staleDir, ".usermod-stamp.json"))) {
    step(`removing stale ${staleDir} directory from the earlier install method`);
    fs.rmSync(staleDir, { recursive: true, force: true });
  }
  ok(`\nNest Studio ${version} is now patched for user mods.`);
  console.log(`  archive : ${asar}  (original kept at ${asarOrig})`);
  console.log(`  loader  : ${LOADER_MAIN}`);
  console.log(`  options : ${BUILD_OPTIONS.map((o) => `${o.label}=${flags[o.id] ? "on" : "off"}`).join(", ")}`);
  console.log(`  log     : ${path.join(ROOT, "usermod.log")}`);
  console.log("Start Nest Studio normally. Re-run after any app update; --uninstall restores the original.");
  if (IS_MAC) {
    console.log(
      "macOS: swapping app.asar breaks the bundle's code-signature seal; already-approved apps still launch (Gatekeeper only\n" +
        `checks the seal on first launch, and this build's asar-integrity fuse is off). If macOS ever refuses to start it, run:\n` +
        `  xattr -dr com.apple.quarantine "${options.installRoot}" && codesign --force --deep --sign - "${options.installRoot}"`
    );
  }
}

async function uninstall(options: Options): Promise<void> {
  const resources = resourcesDir(options.installRoot);
  const asar = path.join(resources, "app.asar");
  const asarOrig = path.join(resources, "app.asar.orig");
  if (!fs.existsSync(asarOrig)) fail(`no backup at ${asarOrig}; nothing to restore`);
  assertClosed();
  assertWritable(resources);
  if (!options.yes) {
    const answer = await prompts({ type: "confirm", name: "go", message: `Restore ${asarOrig} over app.asar?`, initial: true });
    if (!answer.go) return;
  }
  fs.copyFileSync(asarOrig, asar);
  fs.unlinkSync(asarOrig);
  fs.rmSync(FLAGS_FILE, { force: true });
  ok("Restored original app.asar. Your mods in this repo are untouched.");
}

/* -------------------------------------------------------------------- menu */
async function menu(options: Options): Promise<void> {
  const resources = resourcesDir(options.installRoot);
  const installed = fs.existsSync(path.join(resources, "app.asar.orig"));
  const answer = await prompts({
    type: "select",
    name: "action",
    message: `Nest Studio user mods  ${color(90, `(${options.installRoot}${installed ? ", loader installed" : ", not installed"})`)}`,
    choices: [
      { title: installed ? "Re-install / update loader" : "Install loader", value: "install", description: `Rebuild app.asar with the loader and build options (needs ${IS_MAC ? "write access to the app bundle" : "an elevated terminal"})` },
      { title: "Build only", value: "build-only", description: "Build build/app.asar without touching the install" },
      { title: "Enable / disable mods", value: "select-mods", description: "Fallback for the in-app Enable/disable mods window, e.g. to switch off a mod that breaks the UI" },
      { title: "Uninstall", value: "uninstall", description: "Restore the original app.asar", disabled: !installed },
      { title: "Exit", value: "exit" }
    ]
  });
  const action = answer.action as string | undefined;
  if (!action || action === "exit") return;
  if (action === "install") await install(options, false);
  else if (action === "build-only") await install(options, true);
  else if (action === "select-mods") await selectMods();
  else if (action === "uninstall") await uninstall(options);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32" && !IS_MAC) warn("Nest Studio user mods target Windows and macOS; paths and process checks assume them.");
  if (applyModFlags(options) && options.action === "menu") return;
  switch (options.action) {
    case "select-mods":
      await selectMods();
      break;
    case "menu":
      await menu(options);
      break;
    case "install":
      await install(options, false);
      break;
    case "build-only":
      await install(options, true);
      break;
    case "uninstall":
      await uninstall(options);
      break;
  }
}

main().catch((error: unknown) => {
  console.error(color(31, `ERROR: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
