/*
 * Keyboard jog: on the Device tab, hold the arrow keys (X/Y), PgUp/PgDn (Z) to jog the connected machine
 * with a GRBL $J= command, release to stop (jog cancel 0x85). Uses the same command shape the app itself
 * sends from its jog buttons. Ignored while typing in an input.
 *
 * Moves the machine: keep your hand near the stop button while trying it. Speeds are in mm/min.
 * mods.json settings ("keyboard-jog"): feed (default 1500), zFeed (default 600), distance (mm per key hold,
 * default 200), requireDeviceTab (default true)
 */
(function keyboardJog(): void {
  const rt = window.usermodRuntime;
  rt.register({ name: "keyboard-jog", version: "0.1.0" });

  let settings = { feed: 1500, zFeed: 600, distance: 200, requireDeviceTab: true };
  void window.usermod.info().then((r) => {
    if (!r.ok) return;
    const m = r.data.config.settings["keyboard-jog"] ?? {};
    settings = { feed: Number(m.feed ?? 1500) || 1500, zFeed: Number(m.zFeed ?? 600) || 600, distance: Number(m.distance ?? 200) || 200, requireDeviceTab: m.requireDeviceTab !== false };
  });

  const send = (payload: string): Promise<NestStudio.Result<unknown>> => window.api.device.sendMessage({ type: "text", payload });
  const AXES: Record<string, [axis: "X" | "Y" | "Z", sign: 1 | -1]> = {
    ArrowRight: ["X", 1],
    ArrowLeft: ["X", -1],
    ArrowUp: ["Y", 1],
    ArrowDown: ["Y", -1],
    PageUp: ["Z", 1],
    PageDown: ["Z", -1]
  };
  let active: string | null = null;
  const typing = (): boolean => {
    const el = document.activeElement;
    return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  };
  const onDevice = (): boolean => !settings.requireDeviceTab || window.location.hash.startsWith("#/device");

  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const map = AXES[e.key];
      if (!map || e.ctrlKey || e.altKey || e.metaKey || typing() || !onDevice()) return;
      e.preventDefault();
      if (e.repeat || active) return;
      const [axis, sign] = map;
      const d = (sign * settings.distance).toFixed(3);
      const feed = axis === "Z" ? settings.zFeed : settings.feed;
      const cmd = axis === "X" ? `$J=G21G91X${d}Y0Z0F${feed}` : axis === "Y" ? `$J=G21G91X0Y${d}Z0F${feed}` : `$J=G21G91X0Y0Z${d}F${feed}`;
      active = e.key;
      void send(cmd).then((r) => {
        if (!r.ok) {
          active = null;
          rt.toast(`Jog failed: ${r.message ?? r.code ?? "send error"}`, { kind: "error" });
        }
      });
    },
    true
  );
  const stop = (): void => {
    if (!active) return;
    active = null;
    void send(String.fromCharCode(0x85));
  };
  window.addEventListener("keyup", (e: KeyboardEvent) => {
    if (e.key === active) stop();
  }, true);
  window.addEventListener("blur", stop);
  rt.onRoute(() => stop());
})();
