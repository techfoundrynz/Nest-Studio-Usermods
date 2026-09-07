"use strict";
/*
 * Nest Studio user-mod loader (main process).
 * Injected as the first statement of out/main/index.js by tools/install.ps1.
 * Everything here is wrapped so a broken mod can never stop the app from starting.
 */
const LOADER_VERSION = "0.2.0";
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const electron = require("electron");
const { app, ipcMain, shell, BrowserWindow } = electron;

const MOD_DIR = path.resolve(__dirname, "..");
const DIRS = {
  postprocessors: path.join(MOD_DIR, "postprocessors"),
  ui: path.join(MOD_DIR, "ui"),
  main: path.join(MOD_DIR, "main"),
  data: path.join(MOD_DIR, "data")
};
const LOG_FILE = path.join(MOD_DIR, "usermod.log");
const CONFIG_FILE = path.join(MOD_DIR, "mods.json");
const GCODE_EXT = /\.(nc|gcode|tap|ngc|cnc)$/i;

const state = {
  config: { disabled: [], settings: {} },
  postprocessors: [],
  mainMods: [],
  errors: []
};

/* ---------------------------------------------------------------- logging */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function formatValue(value) {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
  return typeof value === "string" ? value : safeJson(value);
}
function log(level, ...values) {
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
function recordError(scope, error) {
  const message = error instanceof Error ? error.message : String(error);
  state.errors.push({ scope, message, time: Date.now() });
  if (state.errors.length > 50) state.errors.shift();
  log("error", `${scope}:`, error);
}

/* ----------------------------------------------------------------- config */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      state.config = {
        disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
        settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {}
      };
    }
  } catch (error) {
    recordError("config", error);
  }
  return state.config;
}
function modNameFromFile(file) {
  return path.basename(file).replace(/\.js$/i, "");
}
function isDisabled(file) {
  const name = modNameFromFile(file);
  return name.startsWith("_") || state.config.disabled.includes(name);
}
function listModFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".js"))
      .sort((a, b) => a.localeCompare(b, "en"))
      .map((f) => path.join(dir, f))
      .filter((f) => !isDisabled(f));
  } catch (error) {
    recordError(`list:${dir}`, error);
    return [];
  }
}
function freshRequire(file) {
  delete require.cache[require.resolve(file)];
  return require(file);
}
function settingsFor(name) {
  return state.config.settings[name] ?? {};
}

/* --------------------------------------------------------- postprocessors */
function loadPostprocessors() {
  const loaded = [];
  for (const file of listModFiles(DIRS.postprocessors)) {
    try {
      const mod = freshRequire(file);
      const def = typeof mod === "function" ? { process: mod } : mod;
      if (!def || typeof def.process !== "function") {
        throw new Error("postprocessor must export an object with a process(gcode, ctx) function");
      }
      loaded.push({
        name: def.name || modNameFromFile(file),
        file,
        description: typeof def.description === "string" ? def.description : "",
        stages: Array.isArray(def.stages) && def.stages.length ? def.stages : ["export"],
        includeInternal: Boolean(def.includeInternal),
        match: typeof def.match === "function" ? def.match : null,
        process: def.process
      });
    } catch (error) {
      recordError(`postprocessor:${path.basename(file)}`, error);
    }
  }
  state.postprocessors = loaded;
  log(
    "info",
    `loaded ${loaded.length} postprocessor(s):`,
    loaded.map((p) => `${p.name}[${p.stages.join(",")}]`).join(", ") || "(none)"
  );
  return loaded;
}
function isInternalPath(filePath) {
  try {
    const userData = app.getPath("userData").toLowerCase();
    return path.resolve(String(filePath)).toLowerCase().startsWith(userData);
  } catch {
    return false;
  }
}
async function runPostprocessors(stage, gcode, ctx = {}) {
  if (typeof gcode !== "string") return gcode;
  let current = gcode;
  const applied = [];
  for (const pp of state.postprocessors) {
    if (!pp.stages.includes(stage)) continue;
    if (ctx.internal && !pp.includeInternal) continue;
    const fullCtx = {
      ...ctx,
      stage,
      settings: settingsFor(pp.name),
      dataDir: DIRS.data,
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
    log(
      "info",
      `stage=${stage} applied [${applied.join(" -> ")}] target=${ctx.filePath ?? ctx.fileName ?? "?"} bytes=${gcode.length}->${current.length}`
    );
  }
  return current;
}

/* ---------------------------------------------------- ipc handler hooking */
const originalHandle = ipcMain.handle.bind(ipcMain);
function wrapHandler(channel, listener) {
  if (channel === "store:write-file") {
    return async (event, filePath, data) => {
      try {
        if (typeof data === "string" && typeof filePath === "string" && GCODE_EXT.test(filePath)) {
          data = await runPostprocessors("export", data, {
            filePath,
            fileName: path.basename(filePath),
            internal: isInternalPath(filePath)
          });
        }
      } catch (error) {
        recordError("hook:store:write-file", error);
      }
      return listener(event, filePath, data);
    };
  }
  if (channel === "device:send-gcode" || channel === "device:sync-gcode-to-small-screen") {
    return async (event, options) => {
      try {
        if (options && typeof options.gcode === "string") {
          const gcode = await runPostprocessors("send", options.gcode, {
            fileName: options.fileName,
            channel,
            internal: false
          });
          options = { ...options, gcode };
        }
      } catch (error) {
        recordError(`hook:${channel}`, error);
      }
      return listener(event, options);
    };
  }
  return listener;
}
ipcMain.handle = function patchedHandle(channel, listener) {
  return originalHandle(channel, wrapHandler(channel, listener));
};

/* -------------------------------------------------------------- main mods */
function getMainWindow() {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return windows.find((w) => w.webContents.getURL().includes("renderer/index.html")) ?? windows[0] ?? null;
}
function wrapIpcResult(scope, fn) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      recordError(scope, error);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
}
function createModApi(name) {
  return {
    name,
    electron,
    app,
    modDir: MOD_DIR,
    dataDir: DIRS.data,
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
      const win = getMainWindow();
      if (win) win.webContents.send(`usermod:${channel}`, payload);
    },
    getMainWindow,
    readStore: () => JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "store.json"), "utf8")),
    runPostprocessors
  };
}
function loadMainMods() {
  for (const file of listModFiles(DIRS.main)) {
    const name = modNameFromFile(file);
    try {
      const mod = freshRequire(file);
      const activate = typeof mod === "function" ? mod : mod?.activate;
      if (typeof activate !== "function") throw new Error("main mod must export activate(api) or a function");
      const api = createModApi(name);
      Promise.resolve(activate(api)).catch((error) => recordError(`main-mod-activate:${name}`, error));
      state.mainMods.push({ name, file, description: typeof mod?.description === "string" ? mod.description : "" });
    } catch (error) {
      recordError(`main-mod:${name}`, error);
    }
  }
  log(
    "info",
    `activated ${state.mainMods.length} main mod(s):`,
    state.mainMods.map((m) => m.name).join(", ") || "(none)"
  );
}

/* ----------------------------------------------------------- ui mod list */
function listUiMods() {
  const runtime = path.join(__dirname, "ui-runtime.js");
  const entries = [{ name: "ui-runtime", file: runtime, url: pathToFileURL(runtime).href }];
  for (const file of listModFiles(DIRS.ui)) {
    entries.push({ name: modNameFromFile(file), file, url: pathToFileURL(file).href });
  }
  return entries;
}

/* --------------------------------------------------- loader ipc endpoints */
function resolveInsideModDir(relPath, root = MOD_DIR) {
  if (typeof relPath !== "string" || relPath.includes("\0")) throw new Error("invalid path");
  const resolved = path.resolve(root, relPath);
  const rootNorm = path.resolve(root).toLowerCase();
  const resolvedNorm = resolved.toLowerCase();
  if (!(resolvedNorm === rootNorm || resolvedNorm.startsWith(rootNorm + path.sep))) {
    throw new Error("path escapes the mod directory");
  }
  return resolved;
}
function getInfo() {
  return {
    loaderVersion: LOADER_VERSION,
    modDir: MOD_DIR,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    config: state.config,
    postprocessors: state.postprocessors.map((p) => ({ name: p.name, file: p.file, stages: p.stages, description: p.description })),
    mainMods: state.mainMods,
    uiMods: listUiMods().slice(1),
    errors: state.errors
  };
}
function registerLoaderIpc() {
  const define = (channel, fn) => {
    ipcMain.removeHandler(`usermod:${channel}`);
    originalHandle(`usermod:${channel}`, wrapIpcResult(`ipc:${channel}`, fn));
  };
  define("info", () => getInfo());
  define("list-ui-mods", () => listUiMods());
  define("read-file", (relPath) => fs.readFileSync(resolveInsideModDir(relPath), "utf8"));
  define("write-file", (relPath, text) => {
    const target = resolveInsideModDir(relPath, DIRS.data);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(text), "utf8");
    return target;
  });
  define("log", (level, ...values) =>
    log(["info", "warn", "error"].includes(level) ? level : "info", "[renderer]", ...values)
  );
  define("reload", () => {
    loadConfig();
    loadPostprocessors();
    return getInfo();
  });
  define("open-mod-dir", () => shell.openPath(MOD_DIR));
  define("run-postprocessors", (stage, gcode, ctx) =>
    runPostprocessors(stage === "send" ? "send" : "export", gcode, { ...(ctx ?? {}), internal: false })
  );
}

/* --------------------------------------------------------------- startup */
try {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
  log(
    "info",
    `loader ${LOADER_VERSION} starting; app ${app.getVersion()} electron ${process.versions.electron}; modDir=${MOD_DIR}`
  );
  loadConfig();
  loadPostprocessors();
  registerLoaderIpc();
  loadMainMods();
} catch (error) {
  recordError("startup", error);
}

module.exports = { runPostprocessors, getInfo, state, MOD_DIR };
