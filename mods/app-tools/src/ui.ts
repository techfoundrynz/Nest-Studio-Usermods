/*
 * App tools: MODS menu actions backed by main/app-tools.ts (open log folders, CAM service status, CAM API
 * docs) plus the developer keyboard shortcuts that used to be the dev-shortcuts mod:
 *   Ctrl+Shift+M  toggle the MODS panel        Ctrl+Shift+R  reload the renderer (if reloadShortcut is on)
 *   Ctrl+Shift+L  open usermod.log             F12           toggle Chromium DevTools (install with --devtools)
 * mods.json settings ("app-tools"): shortcuts (true), reloadShortcut (true)
 */
(function appToolsUi(): void {
  const rt = window.usermodRuntime;
  rt.register({ name: "app-tools", version: "0.3.0" });

  interface CamStatus {
    base: string;
    reachable: boolean;
    version: string | null;
    time: string | null;
    docs: boolean;
  }
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const r = await window.usermod.invoke<T>(channel, ...args);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  const ui = window.usermodUI;
  /** One toolbar icon; the actions live in its menu so app-tools does not spend five slots. */
  function openMenu(button: HTMLButtonElement): void {
    ui.menu(button, [
      { heading: "Folders" },
      { label: "App logs", title: "Open Nest Studio's log folder", onClick: () => call("tools:open-logs") },
      { label: "User data", title: "Open %APPDATA%\\Nest Studio", onClick: () => call("tools:open-userdata") },
      { label: "usermod.log", title: "Open the mod loader log", onClick: () => call("tools:open-usermod-log") },
      { heading: "CAM service" },
      {
        label: "CAM service status",
        onClick: async () => {
          const s = await call<CamStatus>("tools:cam-status");
          rt.toast(
            s.reachable ? `CAM ${s.version} (${s.time}) on ${s.base}. Docs ${s.docs ? "enabled" : "disabled (set ENABLE_DOCS=1)"}.` : `CAM service unreachable at ${s.base}`,
            { kind: s.reachable ? "success" : "error", duration: 6000 }
          );
        }
      },
      {
        label: "Open API docs",
        title: "Swagger UI (only when the service runs with ENABLE_DOCS=1)",
        onClick: async () => {
          const s = await call<CamStatus>("tools:cam-status");
          if (!s.docs) {
            rt.toast("Swagger docs are off. Re-run the installer with --cam-docs (see docs/launch-options.md).", { kind: "warn", duration: 6000 });
            return;
          }
          await call("tools:open-url", `${s.base}/docs`);
        }
      },
      { heading: "Developer" },
      {
        label: "Toggle DevTools",
        hint: "F12",
        title: "Chromium DevTools for the renderer; needs an install with --devtools",
        onClick: async () => {
          const r = await call<{ enabled: boolean; open: boolean; reason?: string }>("tools:toggle-devtools");
          if (!r.enabled) rt.toast(r.reason ?? "DevTools unavailable", { kind: "warn", duration: 6000 });
        }
      },
      {
        label: "Reload the UI", hint: "Ctrl+Shift+R", onClick: () => {
          rt.toast("Reloading renderer…");
          setTimeout(() => window.location.reload(), 250);
        }
      }
    ]);
  }
  ui.toolbar.addButton({ id: "app-tools", title: "App tools", icon: () => ui.icons.svg("M9 3h6a1 1 0 0 1 1 1v2h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3V4a1 1 0 0 1 1-1zm1 3h4V5h-4v1zM5 8v10h14V8h-3v2h-2V8h-4v2H8V8H5z"), order: 20, onClick: openMenu });

  /* ---------------------------------------------------------- shortcuts */
  let shortcuts = { enabled: true, reload: true };
  void window.usermod.info().then((r) => {
    if (!r.ok) return;
    const mine = r.data.config.settings["app-tools"] ?? {};
    shortcuts = { enabled: mine.shortcuts !== false, reload: mine.reloadShortcut !== false };
  });
  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (!shortcuts.enabled) return;
      if (event.key === "F12" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        // Ctrl+Shift+I is swallowed by the app's main process; F12 is ours.
        event.preventDefault();
        void window.usermod.invoke<{ enabled: boolean; reason?: string }>("tools:toggle-devtools").then((r) => {
          if (r.ok && !r.data.enabled) rt.toast(r.data.reason ?? "DevTools unavailable", { kind: "warn", duration: 6000 });
        });
        return;
      }
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      const key = event.key.toUpperCase();
      if (key === "M") {
        event.preventDefault();
        void ui.consume<{ toggle(): Promise<void> }>("mods-menu")?.toggle();
      } else if (key === "R" && shortcuts.reload) {
        event.preventDefault();
        rt.toast("Reloading renderer…");
        setTimeout(() => window.location.reload(), 250);
      } else if (key === "L") {
        event.preventDefault();
        void window.usermod.invoke("tools:open-usermod-log");
      }
    },
    true
  );
})();
