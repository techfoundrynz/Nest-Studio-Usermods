/*
 * Nest Studio user-mod loader (main process).
 * Injected as the first statement of out/main/index.js by the installer.
 * Discovers mods from <repo>/mods/<pkg>/package.json "usermod" manifests, honours mods.json, hooks the
 * app's G-code IPC channels for post-processors and exposes the usermod:* IPC surface.
 * Everything here is wrapped so a broken mod can never stop the app from starting.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
// Plain require so the very same module object the app uses is patched and handed to mods.
import electron = require("electron");

const LOADER_VERSION = "0.3.0";
const { app, ipcMain, shell, BrowserWindow } = electron;

/** packages/loader/dist -> repo root. */
const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const MODS_DIR = path.join(ROOT_DIR, "mods");
const DATA_DIR = path.join(ROOT_DIR, "data");
const LOG_FILE = path.join(ROOT_DIR, "usermod.log");
const CONFIG_FILE = path.join(ROOT_DIR, "mods.json");
/** Tracked template; mods.json itself is per machine and git-ignored. */
const CONFIG_DEFAULT_FILE = path.join(ROOT_DIR, "mods.default.json");
const GCODE_EXT = /\.(nc|gcode|tap|ngc|cnc)$/i;

interface Manifest {
  name: string;
  dir: string;
  description: string;
  order: number;
  core: boolean;
  /** Declared in the manifest; undefined = derive from kinds. */
  reload?: Usermod.ReloadLevel;
  postprocessor?: string;
  ui?: string;
  main?: string;
}
const isReloadLevel = (value: unknown): value is Usermod.ReloadLevel => value === "none" || value === "ui" || value === "app";
function reloadLevelFor(m: Manifest): Usermod.ReloadLevel {
  if (m.reload) return m.reload;
  if (m.main) return "app";
  if (m.ui) return "ui";
  return "none";
}
interface LoadedPostprocessor {
  name: string;
  file: string;
  description: string;
  stages: Usermod.Stage[];
  includeInternal: boolean;
  match: ((ctx: Usermod.PostprocessorContext) => boolean) | null;
  process: Usermod.Postprocessor["process"];
}
interface LoaderState {
  config: Usermod.Config;
  manifests: Manifest[];
  postprocessors: LoadedPostprocessor[];
  mainMods: Usermod.MainModSummary[];
  errors: Usermod.LoaderError[];
}
const state: LoaderState = {
  config: { enabled: [], settings: {} },
  manifests: [],
  postprocessors: [],
  mainMods: [],
  errors: []
};

/* ---------------------------------------------------------------- logging */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function formatValue(value: unknown): string {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
  return typeof value === "string" ? value : safeJson(value);
}
function log(level: Usermod.LogLevel, ...values: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${values.map(formatValue).join(" ")}\n`;
  try {
    try {
      if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      /* no log file yet */
    }
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    /* ignore logging failures */
  }
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  method("[usermod]", ...values);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function recordError(scope: string, error: unknown): void {
  state.errors.push({ scope, message: errorMessage(error), time: Date.now() });
  if (state.errors.length > 50) state.errors.shift();
  log("error", `${scope}:`, error);
}

/* ----------------------------------------------------------------- config */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function loadConfig(): Usermod.Config {
  try {
    if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(CONFIG_DEFAULT_FILE)) {
      fs.copyFileSync(CONFIG_DEFAULT_FILE, CONFIG_FILE);
      log("info", "created mods.json from mods.default.json");
    }
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((d): d is string => typeof d === "string") : []);
      const enabled = isRecord(parsed) && Array.isArray(parsed.enabled) ? names(parsed.enabled) : [];
      const settings: Usermod.Config["settings"] = {};
      if (isRecord(parsed) && isRecord(parsed.settings)) {
        for (const [key, value] of Object.entries(parsed.settings)) {
          if (isRecord(value)) settings[key] = value;
        }
      }
      state.config = { enabled, settings };
    }
  } catch (error) {
    recordError("config", error);
  }
  return state.config;
}
function settingsFor(name: string): Record<string, unknown> {
  return state.config.settings[name] ?? {};
}

/* -------------------------------------------------------------- manifests */
function readManifest(dir: string): Manifest | null {
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) return null;
  const pkg: unknown = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  if (!isRecord(pkg) || !isRecord(pkg.usermod)) return null;
  const m = pkg.usermod;
  const fallbackName = typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : path.basename(dir);
  const entry = (key: string): string | undefined => (typeof m[key] === "string" ? path.resolve(dir, m[key] as string) : undefined);
  return {
    name: typeof m.name === "string" && m.name ? m.name : fallbackName,
    dir,
    description: typeof m.description === "string" ? m.description : typeof pkg.description === "string" ? pkg.description : "",
    order: typeof m.order === "number" ? m.order : 100,
    core: m.core === true,
    ...(isReloadLevel(m.reload) ? { reload: m.reload } : {}),
    ...(entry("postprocessor") ? { postprocessor: entry("postprocessor") } : {}),
    ...(entry("ui") ? { ui: entry("ui") } : {}),
    ...(entry("main") ? { main: entry("main") } : {})
  };
}
function discoverManifests(): Manifest[] {
  const found: Manifest[] = [];
  try {
    if (!fs.existsSync(MODS_DIR)) return found;
    for (const name of fs.readdirSync(MODS_DIR)) {
      const dir = path.join(MODS_DIR, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const manifest = readManifest(dir);
        if (manifest) found.push(manifest);
      } catch (error) {
        recordError(`manifest:${name}`, error);
      }
    }
  } catch (error) {
    recordError("discover", error);
  }
  found.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "en"));
  state.manifests = found;
  return found;
}
function isEnabled(manifest: Manifest): boolean {
  return manifest.core || state.config.enabled.includes(manifest.name);
}
function enabledManifests(): Manifest[] {
  return state.manifests.filter(isEnabled);
}
function availableMods(): Usermod.AvailableMod[] {
  return state.manifests.map((m) => ({
    name: m.name,
    description: m.description,
    kinds: (["postprocessor", "main", "ui"] as const).filter((k) => Boolean(m[k])),
    order: m.order,
    enabled: isEnabled(m),
    core: m.core,
    reload: reloadLevelFor(m),
    reloadDeclared: m.reload !== undefined,
    active: { main: state.mainMods.some((x) => x.name === m.name), postprocessor: state.postprocessors.some((p) => p.name === m.name) }
  }));
}
function freshRequire(file: string): unknown {
  delete require.cache[require.resolve(file)];
  return require(file) as unknown;
}

/* --------------------------------------------------------- postprocessors */
function isPostprocessor(value: unknown): value is Usermod.Postprocessor {
  return isRecord(value) && typeof value.process === "function";
}
function isStage(value: unknown): value is Usermod.Stage {
  return value === "export" || value === "send";
}
function loadPostprocessors(): LoadedPostprocessor[] {
  const loaded: LoadedPostprocessor[] = [];
  for (const manifest of enabledManifests()) {
    if (!manifest.postprocessor) continue;
    try {
      if (!fs.existsSync(manifest.postprocessor)) throw new Error(`not built: ${manifest.postprocessor}`);
      const mod = freshRequire(manifest.postprocessor);
      const def: unknown = typeof mod === "function" ? { process: mod } : mod;
      if (!isPostprocessor(def)) throw new Error("postprocessor must export an object with a process(gcode, ctx) function");
      const stages = Array.isArray(def.stages) ? def.stages.filter(isStage) : [];
      loaded.push({
        name: manifest.name,
        file: manifest.postprocessor,
        description: manifest.description || (typeof def.description === "string" ? def.description : ""),
        stages: stages.length ? stages : ["export"],
        includeInternal: Boolean(def.includeInternal),
        match: typeof def.match === "function" ? def.match.bind(def) : null,
        process: def.process.bind(def)
      });
    } catch (error) {
      recordError(`postprocessor:${manifest.name}`, error);
    }
  }
  state.postprocessors = loaded;
  log("info", `loaded ${loaded.length} postprocessor(s):`, loaded.map((p) => `${p.name}[${p.stages.join(",")}]`).join(", ") || "(none)");
  return loaded;
}
function isInternalPath(filePath: string): boolean {
  try {
    const userData = app.getPath("userData").toLowerCase();
    return path.resolve(filePath).toLowerCase().startsWith(userData);
  } catch {
    return false;
  }
}
async function runPostprocessors(stage: Usermod.Stage, gcode: string, ctx: Usermod.RunContextInput & { internal?: boolean } = {}): Promise<string> {
  if (typeof gcode !== "string") return gcode;
  let current = gcode;
  const applied: string[] = [];
  for (const pp of state.postprocessors) {
    if (!pp.stages.includes(stage)) continue;
    if (ctx.internal && !pp.includeInternal) continue;
    const fullCtx: Usermod.PostprocessorContext = {
      ...ctx,
      stage,
      internal: Boolean(ctx.internal),
      settings: settingsFor(pp.name),
      dataDir: DATA_DIR,
      log: (...values) => log("info", `[${pp.name}]`, ...values),
      warn: (...values) => log("warn", `[${pp.name}]`, ...values)
    };
    try {
      if (pp.match && !pp.match(fullCtx)) continue;
      const result = await pp.process(current, fullCtx);
      if (typeof result === "string") {
        current = result;
        applied.push(pp.name);
      } else if (result !== undefined && result !== null) {
        log("warn", `postprocessor ${pp.name} returned a non-string; ignoring its output`);
      }
    } catch (error) {
      recordError(`postprocessor-run:${pp.name}`, error);
    }
  }
  if (applied.length) {
    log("info", `stage=${stage} applied [${applied.join(" -> ")}] target=${ctx.filePath ?? ctx.fileName ?? "?"} bytes=${gcode.length}->${current.length}`);
  }
  return current;
}

/* ------------------------------------------------------------ event bus */
type Listener<K extends keyof Usermod.LoaderEvents> = (payload: Usermod.LoaderEvents[K]) => void;
const listeners = new Map<keyof Usermod.LoaderEvents, Set<Listener<keyof Usermod.LoaderEvents>>>();
function emit<K extends keyof Usermod.LoaderEvents>(event: K, payload: Usermod.LoaderEvents[K]): void {
  for (const listener of listeners.get(event) ?? []) {
    try {
      (listener as Listener<K>)(payload);
    } catch (error) {
      recordError(`event:${event}`, error);
    }
  }
}
const events: Usermod.LoaderEventBus = {
  on(event, listener) {
    const set = listeners.get(event) ?? new Set();
    set.add(listener as Listener<keyof Usermod.LoaderEvents>);
    listeners.set(event, set);
    return () => void set.delete(listener as Listener<keyof Usermod.LoaderEvents>);
  }
};
const countLines = (text: string): number => (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);

/* ---------------------------------------------------- ipc handler hooking */
type IpcListener = Parameters<typeof ipcMain.handle>[1];
const originalHandle = ipcMain.handle.bind(ipcMain);

function wrapHandler(channel: string, listener: IpcListener): IpcListener {
  if (channel === "store:write-file") {
    return async (event, filePath: unknown, data: unknown) => {
      try {
        if (typeof data === "string" && typeof filePath === "string" && GCODE_EXT.test(filePath)) {
          const internal = isInternalPath(filePath);
          const processed = await runPostprocessors("export", data, { filePath, fileName: path.basename(filePath), internal });
          data = processed;
          emit("gcode-exported", { filePath, fileName: path.basename(filePath), lines: countLines(processed), bytes: processed.length, internal });
        }
      } catch (error) {
        recordError("hook:store:write-file", error);
      }
      return listener(event, filePath, data);
    };
  }
  if (channel === "device:send-gcode" || channel === "device:sync-gcode-to-small-screen") {
    return async (event, options: unknown) => {
      try {
        if (isRecord(options) && typeof options.gcode === "string") {
          const fileName = typeof options.fileName === "string" ? options.fileName : undefined;
          const gcode = await runPostprocessors("send", options.gcode, { fileName, channel, internal: false });
          options = { ...options, gcode };
          emit("gcode-sent", { channel, fileName, lines: countLines(gcode), bytes: gcode.length });
        }
      } catch (error) {
        recordError(`hook:${channel}`, error);
      }
      return listener(event, options);
    };
  }
  return listener;
}
ipcMain.handle = (channel, listener) => originalHandle(channel, wrapHandler(channel, listener));

/* -------------------------------------------------------------- main mods */
function getMainWindow(): electron.BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return windows.find((w) => w.webContents.getURL().includes("renderer/index.html")) ?? windows[0] ?? null;
}
function wrapIpcResult(scope: string, fn: Usermod.IpcHandler): IpcListener {
  return async (_event, ...args: unknown[]): Promise<Usermod.IpcResult<unknown>> => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      recordError(scope, error);
      return { ok: false, message: errorMessage(error) };
    }
  };
}
function createModApi(name: string): Usermod.MainModApi {
  return {
    name,
    electron,
    app,
    modDir: ROOT_DIR,
    distDir: MODS_DIR,
    dataDir: DATA_DIR,
    settings: settingsFor(name),
    whenReady: () => app.whenReady(),
    log: (...values) => log("info", `[${name}]`, ...values),
    warn: (...values) => log("warn", `[${name}]`, ...values),
    error: (...values) => log("error", `[${name}]`, ...values),
    handle: (channel, fn) => {
      const full = `usermod:${channel}`;
      ipcMain.removeHandler(full);
      originalHandle(full, wrapIpcResult(`mod-ipc:${name}:${channel}`, fn));
    },
    send: (channel, payload) => {
      getMainWindow()?.webContents.send(`usermod:${channel}`, payload);
    },
    getMainWindow,
    events,
    readStore: () => JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "store.json"), "utf8")) as NestStudio.Store,
    runPostprocessors
  };
}
function isMainMod(value: unknown): value is Usermod.MainMod {
  return isRecord(value) && typeof value.activate === "function";
}
/** Activates enabled main mods that are not active yet (safe to call again after set-enabled). */
function loadMainMods(): void {
  for (const manifest of enabledManifests()) {
    if (!manifest.main || state.mainMods.some((m) => m.name === manifest.name)) continue;
    try {
      if (!fs.existsSync(manifest.main)) throw new Error(`not built: ${manifest.main}`);
      const mod = freshRequire(manifest.main);
      const def: unknown = typeof mod === "function" ? { activate: mod } : mod;
      if (!isMainMod(def)) throw new Error("main mod must export { activate(api) } or a function");
      const api = createModApi(manifest.name);
      Promise.resolve(def.activate(api)).catch((error: unknown) => recordError(`main-mod-activate:${manifest.name}`, error));
      state.mainMods.push({ name: manifest.name, file: manifest.main, description: manifest.description || (typeof def.description === "string" ? def.description : "") });
    } catch (error) {
      recordError(`main-mod:${manifest.name}`, error);
    }
  }
  log("info", `activated ${state.mainMods.length} main mod(s):`, state.mainMods.map((m) => m.name).join(", ") || "(none)");
}

/* ----------------------------------------------------------- ui mod list */
const UI_KIT = path.join(ROOT_DIR, "packages", "ui-kit", "dist", "index.js");
function listUiMods(): Usermod.UiModEntry[] {
  const runtime = path.join(__dirname, "ui-runtime.js");
  const entries: Usermod.UiModEntry[] = [{ name: "ui-runtime", file: runtime, url: pathToFileURL(runtime).href, builtin: true }];
  if (fs.existsSync(UI_KIT)) entries.push({ name: "ui-kit", file: UI_KIT, url: pathToFileURL(UI_KIT).href, builtin: true });
  else recordError("ui-kit", new Error(`not built: ${UI_KIT}`));
  for (const manifest of enabledManifests()) {
    if (!manifest.ui) continue;
    if (!fs.existsSync(manifest.ui)) {
      recordError(`ui:${manifest.name}`, new Error(`not built: ${manifest.ui}`));
      continue;
    }
    entries.push({ name: manifest.name, file: manifest.ui, url: pathToFileURL(manifest.ui).href });
  }
  return entries;
}

/* --------------------------------------------------- loader ipc endpoints */
function resolveInside(relPath: unknown, root: string): string {
  if (typeof relPath !== "string" || relPath.includes("\0")) throw new Error("invalid path");
  const resolved = path.resolve(root, relPath);
  const rootNorm = path.resolve(root).toLowerCase();
  const resolvedNorm = resolved.toLowerCase();
  if (!(resolvedNorm === rootNorm || resolvedNorm.startsWith(rootNorm + path.sep))) {
    throw new Error("path escapes the mod directory");
  }
  return resolved;
}
function readBuildFlags(): Usermod.Info["buildFlags"] {
  try {
    const file = path.join(ROOT_DIR, "build", "flags.json");
    if (!fs.existsSync(file)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.flags)) return undefined;
    const flags: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed.flags)) flags[key] = value === true;
    return {
      ...(typeof parsed.appVersion === "string" ? { appVersion: parsed.appVersion } : {}),
      ...(typeof parsed.installedAt === "string" ? { installedAt: parsed.installedAt } : {}),
      flags
    };
  } catch {
    return undefined;
  }
}
function getInfo(): Usermod.Info {
  const buildFlags = readBuildFlags();
  return {
    ...(buildFlags ? { buildFlags } : {}),
    loaderVersion: LOADER_VERSION,
    modDir: ROOT_DIR,
    distDir: MODS_DIR,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "",
    config: state.config,
    postprocessors: state.postprocessors.map((p) => ({ name: p.name, file: p.file, stages: p.stages, description: p.description })),
    mainMods: state.mainMods,
    uiMods: listUiMods().filter((entry) => !entry.builtin),
    available: availableMods(),
    errors: state.errors
  };
}
function registerLoaderIpc(): void {
  const define = (channel: string, fn: Usermod.IpcHandler): void => {
    ipcMain.removeHandler(`usermod:${channel}`);
    originalHandle(`usermod:${channel}`, wrapIpcResult(`ipc:${channel}`, fn));
  };
  define("info", () => getInfo());
  define("list-ui-mods", () => listUiMods());
  define("read-file", (relPath: unknown) => fs.readFileSync(resolveInside(relPath, ROOT_DIR), "utf8"));
  define("write-file", (relPath: unknown, text: unknown) => {
    const target = resolveInside(relPath, DATA_DIR);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(text), "utf8");
    return target;
  });
  define("log", (level: unknown, ...values: unknown[]) => {
    const lvl: Usermod.LogLevel = level === "warn" || level === "error" ? level : "info";
    log(lvl, "[renderer]", ...values);
  });
  define("reload", () => {
    loadConfig();
    discoverManifests();
    loadPostprocessors();
    return getInfo();
  });
  const readConfigFile = (): Record<string, unknown> => {
    const raw: unknown = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
    return isRecord(raw) ? raw : {};
  };
  const writeConfigFile = (file: Record<string, unknown>): void => {
    if (!Array.isArray(file.enabled)) file.enabled = [];
    if (!isRecord(file.settings)) file.settings = {};
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    loadConfig();
  };
  define("set-settings", (modName: unknown, settings: unknown) => {
    if (typeof modName !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(modName)) throw new Error("invalid mod name");
    if (!isRecord(settings)) throw new Error("settings must be an object");
    const file = readConfigFile();
    const all = isRecord(file.settings) ? file.settings : {};
    all[modName] = settings;
    file.settings = all;
    writeConfigFile(file);
    log("info", `settings saved for ${modName}`);
    return state.config;
  });
  define("set-enabled", (names: unknown) => {
    if (!Array.isArray(names) || !names.every((n): n is string => typeof n === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(n))) throw new Error("enabled must be an array of mod names");
    const known = new Set(state.manifests.map((m) => m.name));
    const file = readConfigFile();
    file.enabled = [...new Set(names.filter((n) => known.has(n)))].sort();
    writeConfigFile(file);
    discoverManifests();
    loadPostprocessors();
    loadMainMods();
    log("info", `enabled mods: ${(file.enabled as string[]).join(", ") || "(none)"}`);
    return getInfo();
  });
  define("open-mod-dir", () => shell.openPath(ROOT_DIR));
  define("relaunch", () => {
    log("info", "relaunch requested from the MODS menu");
    app.relaunch();
    // Hard exit on purpose: the app's own quit flow intercepts to ask about unsaved work, which the UI checked already.
    setTimeout(() => app.exit(0), 150);
  });
  define("run-postprocessors", (stage: unknown, gcode: unknown, ctx: unknown) => {
    if (typeof gcode !== "string") throw new Error("gcode must be a string");
    const input: Usermod.RunContextInput = isRecord(ctx) ? (ctx as Usermod.RunContextInput) : {};
    return runPostprocessors(stage === "send" ? "send" : "export", gcode, { ...input, internal: false });
  });
}

/* --------------------------------------------------------------- startup */
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  log("info", `loader ${LOADER_VERSION} starting; app ${app.getVersion()} electron ${process.versions.electron ?? "?"}; root=${ROOT_DIR}`);
  loadConfig();
  discoverManifests();
  loadPostprocessors();
  registerLoaderIpc();
  loadMainMods();
} catch (error) {
  recordError("startup", error);
}

export { runPostprocessors, getInfo, state, ROOT_DIR, MODS_DIR };
