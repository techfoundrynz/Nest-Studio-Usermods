#!/usr/bin/env tsx
/*
 * Nest Studio user-mod installer.
 *
 *   pnpm run install:app                 interactive menu (install / select mods / build only / uninstall)
 *   pnpm run install:app -- --install    non-interactive install (or re-install after an app update)
 *   pnpm run install:app -- --uninstall  restore the original app.asar
 *   pnpm run install:app -- --build-only build build/app.asar without touching the install (no admin)
 *   pnpm run install:app -- --select-mods
 *   flags: --force  --skip-build  --install-root=<dir>  --yes
 *
 * Nest Studio's Electron build only loads code from resources\app.asar, so the loader is injected by
 * rebuilding that archive: extract -> patch three files -> repack -> back up the original as
 * app.asar.orig -> copy into place. Only the final copy needs an elevated shell.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import prompts from "prompts";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const LOADER_MAIN = path.join(ROOT, "packages", "loader", "dist", "main.js");
const LOADER_PRELOAD = path.join(ROOT, "packages", "loader", "dist", "preload.js");
const MODS_DIR = path.join(ROOT, "mods");
const CONFIG_FILE = path.join(ROOT, "mods.json");
const BUILD_DIR = path.join(ROOT, "build");
const STAGING_DIR = path.join(BUILD_DIR, "app");
const PACKED_ASAR = path.join(BUILD_DIR, "app.asar");
const STAMP_FILE = path.join(BUILD_DIR, "stamp.json");

const MAIN_MARKER = "/* NEST-USERMOD-MAIN */";
const PRELOAD_BEGIN = "// ==== NEST-USERMOD-PRELOAD-BEGIN ====";
const PRELOAD_END = "// ==== NEST-USERMOD-PRELOAD-END ====";

interface Options {
  action: "menu" | "install" | "uninstall" | "build-only" | "select-mods";
  force: boolean;
  skipBuild: boolean;
  yes: boolean;
  installRoot: string;
}
interface Stamp {
  sourceSha: string;
  packedSha: string;
  builtAt: string;
}
interface ModInfo {
  name: string;
  dir: string;
  description: string;
  kinds: string[];
  enabled: boolean;
}
interface Config {
  disabled: string[];
  settings: Record<string, unknown>;
}

/* ------------------------------------------------------------------ output */
const color = (code: number, text: string): string => (process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const step = (text: string): void => console.log(color(36, "==> ") + text);
const ok = (text: string): void => console.log(color(32, text));
const warn = (text: string): void => console.log(color(33, `WARNING: ${text}`));
class InstallError extends Error { }
const fail = (text: string): never => {
  throw new InstallError(text);
};

/* -------------------------------------------------------------------- args */
function parseArgs(argv: string[]): Options {
  const options: Options = { action: "menu", force: false, skipBuild: false, yes: false, installRoot: "C:\\Program Files\\nest-studio" };
  for (const arg of argv) {
    if (arg === "--install") options.action = "install";
    else if (arg === "--uninstall") options.action = "uninstall";
    else if (arg === "--build-only") options.action = "build-only";
    else if (arg === "--select-mods") options.action = "select-mods";
    else if (arg === "--force") options.force = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg.startsWith("--install-root=")) options.installRoot = arg.slice("--install-root=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]!.replace(/^\/\*\s*/, "").replace(/^ \* ?/gm, ""));
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
  if (process.platform !== "win32") return [];
  const out = spawnSync("tasklist", ["/NH", "/FO", "CSV"], { encoding: "utf8" }).stdout ?? "";
  return out
    .split(/\r?\n/)
    .filter((line) => /^"(nest-studio\.exe|Nest Studio Service\.exe)"/i.test(line))
    .map((line) => line.split('","')[0]!.replace(/^"/, ""));
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
    fail(`cannot write to ${dir}. Run this from an elevated (Administrator) terminal.`);
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
function readConfig(): Config {
  const raw = readJson<Partial<Config>>(CONFIG_FILE, {});
  return { disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((d): d is string => typeof d === "string") : [], settings: raw.settings ?? {} };
}
function discoverMods(config: Config): ModInfo[] {
  if (!fs.existsSync(MODS_DIR)) return [];
  const mods: ModInfo[] = [];
  for (const entry of fs.readdirSync(MODS_DIR)) {
    const dir = path.join(MODS_DIR, entry);
    const pkg = readJson<{ name?: string; description?: string; usermod?: Record<string, unknown> }>(path.join(dir, "package.json"), {});
    if (!pkg.usermod) continue;
    const m = pkg.usermod;
    const name = typeof m.name === "string" ? m.name : (pkg.name ?? entry).replace(/^@[^/]+\//, "");
    const kinds = (["postprocessor", "main", "ui"] as const).filter((k) => typeof m[k] === "string");
    mods.push({ name, dir, description: String(m.description ?? pkg.description ?? ""), kinds, enabled: !config.disabled.includes(name) });
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
async function selectMods(): Promise<void> {
  const config = readConfig();
  const mods = discoverMods(config);
  if (!mods.length) fail(`no mods found under ${MODS_DIR}`);
  const answer = await prompts({
    type: "multiselect",
    name: "enabled",
    message: "Enabled mods (space toggles, enter confirms)",
    instructions: false,
    choices: mods.map((m) => ({ title: `${m.name}  ${color(90, `[${m.kinds.join("+")}] ${m.description}`)}`, value: m.name, selected: m.enabled }))
  });
  if (!Array.isArray(answer.enabled)) return; // cancelled
  const enabled = new Set(answer.enabled as string[]);
  config.disabled = mods.filter((m) => !enabled.has(m.name)).map((m) => m.name);
  writeText(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  ok(`mods.json updated: ${enabled.size} enabled, ${config.disabled.length} disabled (${config.disabled.join(", ") || "none"}).`);
  console.log("Post-processor changes apply after 'Reload post-processors' in the MODS panel; UI/main mods after an app restart.");
}

/* ------------------------------------------------------------------- patch */
function patchMain(file: string): void {
  const source = fs.readFileSync(file, "utf8");
  const inject = `${MAIN_MARKER} try { require(process.env.NEST_MOD_LOADER || ${JSON.stringify(LOADER_MAIN)}); } catch (e) { console.error("[usermod] loader failed to start", e); }`;
  let updated: string;
  if (source.includes(MAIN_MARKER)) {
    updated = source.replace(new RegExp(`${MAIN_MARKER.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[^\r\n]*`), () => inject);
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
function patchCsp(file: string): void {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes("script-src 'self' file:")) step("CSP already allows file: scripts");
  else if (source.includes("script-src 'self';")) {
    fs.writeFileSync(file, source.replace("script-src 'self';", "script-src 'self' file:;"), "utf8");
    step("patched CSP script-src in index.html");
  } else warn("could not find script-src 'self'; in index.html - UI mods may be blocked by CSP");
}

/* ----------------------------------------------------------------- install */
async function install(options: Options, buildOnly: boolean): Promise<void> {
  const resources = path.join(options.installRoot, "resources");
  const asar = path.join(resources, "app.asar");
  const asarOrig = path.join(resources, "app.asar.orig");
  if (!fs.existsSync(asar)) fail(`app.asar not found at ${asar} (use --install-root=<dir>)`);
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
  if (!buildOnly && stamp && stamp.packedSha === currentSha && loaderMatches && !options.force) {
    ok(`Installed app.asar already carries this loader (sha ${currentSha.slice(0, 12)}). Use --force to rebuild.`);
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

  patchMain(path.join(STAGING_DIR, "out", "main", "index.js"));
  patchPreload(path.join(STAGING_DIR, "out", "preload", "index.js"));
  patchCsp(path.join(STAGING_DIR, "out", "renderer", "index.html"));

  step("repacking archive");
  const packed = asarLib.pack(sourceAsar, STAGING_DIR, PACKED_ASAR);
  console.log(`    ${packed.files} files, ${(packed.payloadBytes / 1024 / 1024).toFixed(1)} MB payload -> ${PACKED_ASAR}`);
  const packedSha = sha256(PACKED_ASAR);
  writeText(STAMP_FILE, JSON.stringify({ sourceSha, packedSha, builtAt: new Date().toISOString() } satisfies Stamp, null, 2));
  const version = readJson<{ version?: string }>(path.join(STAGING_DIR, "package.json"), {}).version ?? "?";
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
  const staleDir = path.join(resources, "app");
  if (fs.existsSync(path.join(staleDir, ".usermod-stamp.json"))) {
    step("removing stale resources\\app directory from the earlier install method");
    fs.rmSync(staleDir, { recursive: true, force: true });
  }
  ok(`\nNest Studio ${version} is now patched for user mods.`);
  console.log(`  archive : ${asar}  (original kept at ${asarOrig})`);
  console.log(`  loader  : ${LOADER_MAIN}`);
  console.log(`  log     : ${path.join(ROOT, "usermod.log")}`);
  console.log("Start Nest Studio normally. Re-run after any app update; --uninstall restores the original.");
}

async function uninstall(options: Options): Promise<void> {
  const resources = path.join(options.installRoot, "resources");
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
  ok("Restored original app.asar. Your mods in this repo are untouched.");
}

/* -------------------------------------------------------------------- menu */
async function menu(options: Options): Promise<void> {
  const resources = path.join(options.installRoot, "resources");
  const installed = fs.existsSync(path.join(resources, "app.asar.orig"));
  const answer = await prompts({
    type: "select",
    name: "action",
    message: `Nest Studio user mods  ${color(90, `(${options.installRoot}${installed ? ", loader installed" : ", not installed"})`)}`,
    choices: [
      { title: installed ? "Re-install / update loader" : "Install loader", value: "install", description: "Rebuild app.asar with the loader (needs an elevated terminal)" },
      { title: "Select mods", value: "select-mods", description: "Choose which mods are enabled (writes mods.json)" },
      { title: "Build only", value: "build-only", description: "Build build/app.asar without touching the install" },
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
  if (process.platform !== "win32") warn("Nest Studio user mods target Windows; paths and process checks assume it.");
  switch (options.action) {
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
    case "select-mods":
      await selectMods();
      break;
  }
}

main().catch((error: unknown) => {
  console.error(color(31, `ERROR: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
