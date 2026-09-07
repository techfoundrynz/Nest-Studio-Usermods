/*
 * Keyboard shortcuts for mod development:
 *   Ctrl+Shift+M  toggle the MODS panel
 *   Ctrl+Shift+R  reload the renderer (UI mods re-inject; unsaved UI state is lost)
 *   Ctrl+Shift+L  open usermod.log
 * Configure in mods.json: "dev-shortcuts": { "reload": true }
 */
(function devShortcuts() {
  const rt = window.usermodRuntime;
  rt.register({ name: "dev-shortcuts", version: "0.1.0" });
  let settings = { reload: true };
  window.usermod.info().then((r) => {
    if (r.ok) settings = { ...settings, ...(r.data.config.settings["dev-shortcuts"] ?? {}) };
  });

  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      const key = event.key.toUpperCase();
      if (key === "M") {
        event.preventDefault();
        window.usermodMenu?.toggle();
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
