// ==== NEST-USERMOD-PRELOAD-BEGIN ====
// Everything from this marker to the end of the compiled file is appended to the app's
// out/preload/index.js by tools/install.ps1 (which adds the END marker). Runs inside Electron's
// sandboxed preload, so only require("electron") is available. Exposes window.usermod and injects
// the UI runtime plus every mod in dist/ui.
(function usermodPreload(): void {
  try {
    const { contextBridge, ipcRenderer } = require("electron");
    const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<Usermod.IpcResult<T>> =>
      ipcRenderer.invoke<Usermod.IpcResult<T>>("usermod:" + channel, ...args);
    const bridge: Usermod.Bridge = {
      invoke,
      on: <T = unknown>(channel: string, callback: (payload: T) => void) => {
        const handler = (_event: unknown, payload: T): void => callback(payload);
        ipcRenderer.on<T>("usermod:" + channel, handler);
        return () => ipcRenderer.removeListener<T>("usermod:" + channel, handler);
      },
      info: () => invoke<Usermod.Info>("info"),
      listUiMods: () => invoke<Usermod.UiModEntry[]>("list-ui-mods"),
      readFile: (relPath) => invoke<string>("read-file", relPath),
      exists: (relPath) => invoke<boolean>("exists", relPath),
      writeFile: (relPath, text) => invoke<string>("write-file", relPath, text),
      log: (level, ...values) => invoke<void>("log", level, ...values),
      reload: () => invoke<Usermod.Info>("reload"),
      openModDir: () => invoke<string>("open-mod-dir"),
      runPostprocessors: (stage, gcode, ctx) => invoke<string>("run-postprocessors", stage, gcode, ctx),
      setSettings: (modName, settings) => invoke<Usermod.Config>("set-settings", modName, settings),
      setEnabled: (names) => invoke<Usermod.Info>("set-enabled", names),
      relaunch: () => invoke<void>("relaunch")
    };
    if (process.contextIsolated) {
      contextBridge.exposeInMainWorld("usermod", bridge);
    } else {
      window.usermod = bridge;
    }

    /* Bed size override. Asked for synchronously because the app's renderer chunks read their travel limits
     * and work-platform size while evaluating, which happens right after this preload. Only exposed when the
     * bed-size mod is on, so the app keeps its own numbers otherwise. Needs the installer's --bed-size option. */
    try {
      const bed = ipcRenderer.sendSync<Usermod.BedOverride | undefined>("usermod:bed-sync");
      if (bed?.enabled) {
        if (process.contextIsolated) {
          contextBridge.exposeInMainWorld("__usermodBed", bed.limits);
          contextBridge.exposeInMainWorld("__usermodBedPlatform", bed.platform);
        } else {
          globalThis.__usermodBed = bed.limits;
          globalThis.__usermodBedPlatform = bed.platform;
        }
      }
    } catch {
      /* older loader or no handler: the app keeps its built-in limits */
    }

    const loadScript = (mod: Usermod.UiModEntry): Promise<boolean> =>
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
    const injectUiMods = async (): Promise<void> => {
      const result = await invoke<Usermod.UiModEntry[]>("list-ui-mods");
      if (!result.ok) return;
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
