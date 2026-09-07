/*
 * UI scale (renderer): "UI scale…" in the MODS menu with a zoom picker and a compact-density toggle,
 * plus Ctrl+= / Ctrl+- / Ctrl+0 for zoom. Zoom is applied by the main part (Chromium page zoom) and
 * persisted in mods.json; compact mode overrides the app's spacing / control-height design tokens.
 */
(function uiScale(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "ui-scale", version: "0.1.0" });

  interface Settings {
    zoom: number;
    compact: boolean;
  }
  const STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  let settings: Settings = { zoom: 1, compact: false };

  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const r = await window.usermod.invoke<T>(channel, ...args);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  /* Compact density: tighten the app's own tokens (defined per theme on :root / [data-theme]). */
  const COMPACT_CSS = `html[data-usermod-compact="true"], html[data-usermod-compact="true"] [data-theme] {
    --nest-spacing-xs: 3px; --nest-spacing-sm: 6px; --nest-spacing-md: 9px; --nest-spacing-lg: 12px;
    --nest-spacing-xl: 16px; --nest-spacing-2xl: 22px; --nest-spacing-3xl: 32px; --nest-spacing-4xl: 44px;
    --nest-control-height-sm: 24px; --nest-control-height-md: 28px; --nest-control-height-lg: 34px;
  }`;
  rt.addStyle(COMPACT_CSS, "ui-scale-compact");
  const applyCompact = (on: boolean): void => {
    document.documentElement.setAttribute("data-usermod-compact", on ? "true" : "false");
  };

  const persist = async (): Promise<void> => {
    const r = await window.usermod.setSettings("ui-scale", { zoom: settings.zoom, compact: settings.compact });
    if (!r.ok) throw new Error(r.message);
  };
  const setZoom = async (zoom: number, save = true): Promise<void> => {
    const applied = await call<{ zoom: number }>("ui-scale:set-zoom", zoom);
    settings.zoom = applied.zoom;
    if (save) await persist();
    rt.toast(`Zoom ${Math.round(applied.zoom * 100)}%`, { duration: 1200 });
  };
  const stepZoom = (direction: 1 | -1): Promise<void> => {
    const current = settings.zoom;
    const next = direction > 0 ? STEPS.find((s) => s > current + 0.001) : [...STEPS].reverse().find((s) => s < current - 0.001);
    return next === undefined ? Promise.resolve() : setZoom(next);
  };

  void window.usermod.info().then(async (r) => {
    if (r.ok) {
      const mine = r.data.config.settings["ui-scale"] ?? {};
      settings = { zoom: Number(mine.zoom) || 1, compact: mine.compact === true };
    }
    applyCompact(settings.compact);
    try {
      const z = await call<{ zoom: number; saved: number }>("ui-scale:get-zoom");
      settings.zoom = z.saved;
    } catch {
      /* main part not active yet (enabled without restart); zoom applies after the next app start */
    }
  });

  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        void stepZoom(1);
      } else if (event.key === "-") {
        event.preventDefault();
        void stepZoom(-1);
      } else if (event.key === "0") {
        event.preventDefault();
        void setZoom(1);
      }
    },
    true
  );

  rt.menu.addAction({
    id: "ui-scale",
    label: "UI scale…",
    section: "Appearance",
    order: 20,
    onClick: ({ close }) => {
      close();
      const modal = ui.modal("UI scale", { width: 420 });
      const zoomSelect = ui.select(
        "Zoom",
        STEPS.map((s) => ({ label: `${Math.round(s * 100)}%`, value: String(s) })),
        String(STEPS.includes(settings.zoom) ? settings.zoom : 1),
        (value) => void setZoom(Number(value)),
        "Chromium page zoom; also Ctrl+= / Ctrl+- / Ctrl+0"
      );
      const compactToggle = ui.toggle(
        "Compact density",
        settings.compact,
        async (on) => {
          settings.compact = on;
          applyCompact(on);
          await persist();
        },
        "Tighter spacing and shorter controls (overrides the app's spacing tokens)"
      );
      modal.body.append(zoomSelect, compactToggle, ui.buttonRow([ui.button("Reset", async () => {
        settings.compact = false;
        applyCompact(false);
        await setZoom(1);
        modal.close();
      }), ui.button("Close", () => modal.close(), { primary: true })]));
    }
  });
})();
