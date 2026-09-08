/*
 * Dark mode: Nest Studio ships a complete dark theme (html[data-theme=dark] tokens plus an antd dark
 * theme) driven by app.theme in the user store, but has no switch for it. This mod adds a sun/moon
 * toolbar button that flips app.theme and reloads the renderer so the whole UI re-themes, and can
 * optionally follow the OS colour scheme.
 *
 * mods.json settings ("dark-mode"):
 *   followSystem   apply the OS light/dark preference on startup and when it changes (default false)
 */
(function darkMode(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "dark-mode", version: "0.1.0" });

  interface Settings {
    followSystem: boolean;
  }
  const SESSION_KEY = "usermod.dark-mode.applied";
  let settings: Settings = { followSystem: false };

  const current = (): NestStudio.Theme => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const systemTheme = (): NestStudio.Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  /** Persist the theme in the app's own store and reload so React re-renders with the antd dark theme. */
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

  const handle = ui.toolbar.addButton({
    id: "dark-mode",
    title: "Toggle dark mode (right-click: settings)",
    icon: current() === "dark" ? ui.icons.sun : ui.icons.moon,
    order: 20,
    onClick: toggleTheme,
    onContextMenu: () => openSettings()
  });
  const refreshIcon = (): void => {
    const dark = current() === "dark";
    handle.setIcon(dark ? ui.icons.sun : ui.icons.moon);
    handle.setTitle(`${dark ? "Switch to light theme" : "Switch to dark theme"} (right-click: settings)`);
  };
  new MutationObserver(refreshIcon).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  refreshIcon();

  /** Settings sit on the button's right-click, so dark-mode keeps a single toolbar icon. */
  function openSettings(): void {
      const modal = ui.modal("Dark mode", { width: 420 });
      modal.body.append(
        ui.kv([
          ["Current theme", current()],
          ["OS preference", systemTheme()]
        ]),
        ui.buttonRow([ui.button(current() === "dark" ? "Switch to light" : "Switch to dark", toggleTheme, { primary: true })]),
        ui.settingsForm("dark-mode", {
          title: "Settings",
          fields: [{ key: "followSystem", label: "Follow the OS light/dark setting", type: "boolean", help: "Applies on startup and when the OS switches mode." }],
          reloadPostprocessors: false,
          onSaved: (values) => {
            settings = { followSystem: values.followSystem === true };
            void applySystemPreference();
          }
        })
      );
  }

  async function applySystemPreference(): Promise<void> {
    if (!settings.followSystem) return;
    const wanted = systemTheme();
    if (wanted === current()) return;
    // One automatic switch per session guards against reload loops if the store write did not stick.
    if (sessionStorage.getItem(SESSION_KEY) === wanted) return;
    sessionStorage.setItem(SESSION_KEY, wanted);
    await setTheme(wanted);
  }

  void window.usermod.info().then((r) => {
    if (r.ok) settings = { followSystem: r.data.config.settings["dark-mode"]?.followSystem === true };
    void applySystemPreference();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    sessionStorage.removeItem(SESSION_KEY);
    void applySystemPreference();
  });

  window.usermodDarkMode = { setTheme, toggle: toggleTheme, current };
})();
