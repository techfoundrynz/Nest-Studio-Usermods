/*
 * Keyboard shortcuts for mod development:
 *   Ctrl+Shift+M  toggle the MODS panel
 *   Ctrl+Shift+R  reload the renderer (UI mods re-inject; unsaved UI state is lost)
 *   Ctrl+Shift+L  open usermod.log
 * Configure in mods.json: "dev-shortcuts": { "reload": true }
 */
(function devShortcuts(): void {
  const rt = window.usermodRuntime;
  rt.register({ name: "dev-shortcuts", version: "0.2.0" });
  interface Settings {
    reload: boolean;
  }
  let settings: Settings = { reload: true };
  void window.usermod.info().then((r) => {
    if (r.ok) {
      const mine = r.data.config.settings["dev-shortcuts"] ?? {};
      settings = { reload: mine.reload !== false };
    }
  });

  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      const key = event.key.toUpperCase();
      if (key === "M") {
        event.preventDefault();
        void window.usermodMenu?.toggle();
      } else if (key === "R" && settings.reload) {
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
