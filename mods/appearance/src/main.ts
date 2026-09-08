/*
 * Appearance (main process): applies the saved zoom factor to the main window as soon as it loads and
 * exposes set/get so the UI half (and keyboard shortcuts) can change it. Zoom is Chromium's page zoom,
 * the same thing Ctrl+= does in a browser, so everything scales consistently including antd widgets.
 *
 * mods.json settings ("appearance"): zoom (0.5 .. 2, default 1); theme and density are the UI half's.
 */
const MIN = 0.5;
const MAX = 2;
const clamp = (value: unknown, fallback = 1): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100)) : fallback;
};

const mod: Usermod.MainMod<{ zoom: number; compact: boolean }> = {
  description: "Applies the saved UI zoom factor to the main window; exposes appearance:set-zoom / get-zoom",
  activate(api) {
    let zoom = clamp(api.settings.zoom);
    const isMainWindow = (contents: Electron.WebContents): boolean => contents.getURL().includes("renderer/index.html");
    const apply = (contents: Electron.WebContents): void => {
      try {
        contents.setZoomFactor(zoom);
      } catch (error) {
        api.warn(`setZoomFactor failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    api.electron.app.on("web-contents-created", (_event, contents) => {
      contents.on("did-finish-load", () => {
        if (isMainWindow(contents) && zoom !== 1) apply(contents);
      });
    });
    api.handle("appearance:get-zoom", () => {
      const win = api.getMainWindow();
      return { zoom: win ? win.webContents.getZoomFactor() : zoom, saved: zoom };
    });
    api.handle("appearance:set-zoom", (value: unknown) => {
      zoom = clamp(value, zoom);
      const win = api.getMainWindow();
      if (win) apply(win.webContents);
      return { zoom };
    });
    api.log(`appearance active (zoom ${zoom})`);
  }
};

export = mod;
