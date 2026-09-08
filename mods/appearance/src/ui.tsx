/*
 * Appearance: how Nest Studio looks. One window with the theme and the UI scale, which were the dark-mode and
 * ui-scale mods.
 *
 * Theme: the app ships a complete dark theme (html[data-theme=dark] tokens plus an antd dark theme) driven by
 * app.theme in the user store but has no switch; this writes the store and reloads the renderer so the whole
 * UI re-themes, and can follow the OS setting.
 * Scale: Chromium page zoom (applied by the main half, also Ctrl+= / Ctrl+- / Ctrl+0) and a compact density
 * that overrides the app's own spacing and control-height tokens.
 *
 * mods.json settings ("appearance"): followSystem (false), zoom (1), compact (false)
 */
(function appearance(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Section, Sub, Row, Button, Toggle, Select, KV } = ui.react;
  rt.register({ name: "appearance", version: "0.1.0" });

  interface Settings {
    followSystem: boolean;
    zoom: number;
    compact: boolean;
  }
  const STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const SESSION_KEY = "usermod.appearance.applied";
  let settings: Settings = { followSystem: false, zoom: 1, compact: false };

  const call = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
    const r = await window.usermod.invoke<T>(channel, ...args);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };
  const persist = async (): Promise<void> => {
    const r = await window.usermod.setSettings("appearance", { ...settings });
    if (!r.ok) throw new Error(r.message);
  };

  /* ------------------------------------------------------------------ theme */
  const current = (): NestStudio.Theme => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const systemTheme = (): NestStudio.Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  /** Persist the theme in the app's own store and reload, so React re-renders with the antd dark theme. */
  async function setTheme(theme: NestStudio.Theme): Promise<void> {
    const read = await window.api.store.read();
    if (!read.ok) throw new Error(read.message || read.code || "could not read store");
    const store = read.data;
    if (store.app?.theme === theme && current() === theme) return;
    store.app = { ...(store.app ?? {}), theme };
    const written = await window.api.store.write(store);
    if (!written.ok) throw new Error(written.message || written.code || "could not write store");
    document.documentElement.setAttribute("data-theme", theme); // instant CSS switch while the reload lands
    rt.toast(`Switching to ${theme} theme…`);
    setTimeout(() => window.location.reload(), 350);
  }
  const toggleTheme = (): Promise<void> => setTheme(current() === "dark" ? "light" : "dark");
  async function applySystemPreference(): Promise<void> {
    if (!settings.followSystem) return;
    const wanted = systemTheme();
    if (wanted === current()) return;
    // Once per session: the reload would otherwise fight a user who switched manually.
    if (sessionStorage.getItem(SESSION_KEY) === wanted) return;
    sessionStorage.setItem(SESSION_KEY, wanted);
    await setTheme(wanted);
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => void applySystemPreference());

  /* ------------------------------------------------------------------ scale */
  const COMPACT_CSS = `html[data-usermod-compact="true"], html[data-usermod-compact="true"] [data-theme] {
    --nest-spacing-xs: 3px; --nest-spacing-sm: 6px; --nest-spacing-md: 9px; --nest-spacing-lg: 12px;
    --nest-spacing-xl: 16px; --nest-spacing-2xl: 22px; --nest-spacing-3xl: 32px; --nest-spacing-4xl: 44px;
    --nest-control-height-sm: 24px; --nest-control-height-md: 28px; --nest-control-height-lg: 34px;
  }`;
  rt.addStyle(COMPACT_CSS, "appearance-compact");
  const applyCompact = (on: boolean): void => {
    document.documentElement.setAttribute("data-usermod-compact", on ? "true" : "false");
  };
  const setZoom = async (zoom: number, save = true): Promise<void> => {
    const applied = await call<{ zoom: number }>("appearance:set-zoom", zoom);
    settings.zoom = applied.zoom;
    if (save) await persist();
    rt.toast(`Zoom ${Math.round(applied.zoom * 100)}%`, { duration: 1200 });
  };
  const stepZoom = (direction: 1 | -1): Promise<void> => {
    const from = settings.zoom;
    const next = direction > 0 ? STEPS.find((s) => s > from + 0.001) : [...STEPS].reverse().find((s) => s < from - 0.001);
    return next === undefined ? Promise.resolve() : setZoom(next);
  };

  void window.usermod.info().then(async (r) => {
    if (r.ok) {
      const mine = r.data.config.settings["appearance"] ?? {};
      settings = { followSystem: mine.followSystem === true, zoom: Number(mine.zoom) || 1, compact: mine.compact === true };
    }
    applyCompact(settings.compact);
    try {
      const z = await call<{ zoom: number; saved: number }>("appearance:get-zoom");
      settings.zoom = z.saved;
    } catch {
      /* main half not active yet (enabled without a restart); zoom applies at the next app start */
    }
    await applySystemPreference();
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

  /* --------------------------------------------------------------- the panel */
  function Panel({ close }: { close(): void }): React.JSX.Element {
    const [, force] = React.useState(0);
    const rerender = (): void => force((n) => n + 1);
    const dark = current() === "dark";
    const save = (fn: () => void): void => {
      fn();
      rerender();
      void persist().catch((e: unknown) => rt.toast(e instanceof Error ? e.message : String(e), { kind: "error" }));
    };
    return (
      <>
        <Section title="Theme">
          <KV pairs={[["Current", current()], ["Operating system", systemTheme()]]} />
          <Row>
            <Button label={dark ? "Switch to light" : "Switch to dark"} primary onClick={toggleTheme} />
          </Row>
          <Toggle
            label="Follow the operating system"
            checked={settings.followSystem}
            help="Applies at startup and when the OS switches mode."
            onChange={(on) =>
              save(() => {
                settings.followSystem = on;
                if (on) void applySystemPreference();
              })
            }
          />
        </Section>
        <Section title="Scale">
          <Select
            label="Zoom"
            options={STEPS.map((s) => ({ label: `${Math.round(s * 100)}%`, value: String(s) }))}
            value={String(STEPS.includes(settings.zoom) ? settings.zoom : 1)}
            help="Chromium page zoom; also Ctrl+= / Ctrl+- / Ctrl+0"
            onChange={(value) => void setZoom(Number(value)).then(rerender)}
          />
          <Toggle
            label="Compact density"
            checked={settings.compact}
            help="Tighter spacing and shorter controls (overrides the app's spacing tokens)"
            onChange={(on) =>
              save(() => {
                settings.compact = on;
                applyCompact(on);
              })
            }
          />
        </Section>
        <Sub>The theme change reloads the renderer so the whole UI re-themes; zoom and density apply at once.</Sub>
        <Row>
          <Button
            label="Reset"
            onClick={async () => {
              settings.compact = false;
              applyCompact(false);
              await setZoom(1);
              rerender();
            }}
          />
          <Button label="Close" onClick={close} />
        </Row>
      </>
    );
  }

  const handle = ui.toolbar.addButton({
    id: "appearance",
    title: "Appearance: theme and scale",
    icon: () => (current() === "dark" ? ui.icons.sun() : ui.icons.moon()),
    order: 15,
    onClick: (button) => {
      let pop: Usermod.PopoverHandle | null = null;
      pop = ui.react.popover(button, <Panel close={() => pop?.close()} />, { width: 380 });
    }
  });
  // Keep the icon in step with the theme, whoever changed it.
  new MutationObserver(() => handle.setIcon(current() === "dark" ? ui.icons.sun : ui.icons.moon)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  window.usermodDarkMode = { setTheme, toggle: toggleTheme, current };
})();
