// ==== NEST-USERMOD-PRELOAD-BEGIN ====
// Appended to out/preload/index.js by tools/install.ps1. Runs in the sandboxed preload,
// so only require("electron") is available here. Exposes window.usermod and injects UI mods.
(function usermodPreload() {
  try {
    const { contextBridge, ipcRenderer } = require("electron");
    const invoke = (channel, ...args) => ipcRenderer.invoke("usermod:" + channel, ...args);
    const bridge = {
      invoke,
      on: (channel, callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on("usermod:" + channel, handler);
        return () => ipcRenderer.removeListener("usermod:" + channel, handler);
      },
      info: () => invoke("info"),
      listUiMods: () => invoke("list-ui-mods"),
      readFile: (relPath) => invoke("read-file", relPath),
      writeFile: (relPath, text) => invoke("write-file", relPath, text),
      log: (level, ...values) => invoke("log", level, ...values),
      reload: () => invoke("reload"),
      openModDir: () => invoke("open-mod-dir"),
      runPostprocessors: (stage, gcode, ctx) => invoke("run-postprocessors", stage, gcode, ctx)
    };
    if (process.contextIsolated) {
      contextBridge.exposeInMainWorld("usermod", bridge);
    } else {
      window.usermod = bridge;
    }
    const loadScript = (mod) =>
      new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = mod.url;
        script.dataset.usermod = mod.name;
        script.onload = () => resolve(true);
        script.onerror = () => {
          void invoke("log", "error", "failed to load ui mod " + mod.name + " from " + mod.url);
          resolve(false);
        };
        (document.head || document.documentElement).appendChild(script);
      });
    const injectUiMods = async () => {
      const result = await invoke("list-ui-mods");
      if (!result || !result.ok) return;
      for (const mod of result.data) {
        await loadScript(mod);
      }
    };
    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", () => void injectUiMods());
    } else {
      void injectUiMods();
    }
  } catch (error) {
    console.error("[usermod] preload bridge failed", error);
  }
})();
// ==== NEST-USERMOD-PRELOAD-END ====
