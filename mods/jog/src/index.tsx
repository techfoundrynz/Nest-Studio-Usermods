/*
 * Jog: keyboard and game-controller jogging over one shared engine. Both inputs build the GRBL $J=G21G91… segments
 * the app's own jog buttons send and stop with the app's jog cancel (the text "0x85"). The engine refuses to jog
 * unless a machine is connected and idle (or already jogging), never while a program runs or is held, never in
 * alarm, and (by default) only on the Device tab. Escape, the controller's A button, a tab change and window blur
 * all stop through the same path.
 *
 *   Keyboard   arrows X/Y, PageUp/PageDown Z, hold to move, release to stop; Escape stops. Ignored while typing.
 *   Gamepad    left stick X/Y, right stick vertical or triggers Z, speed follows stick travel; A stop, B feed hold,
 *              hold LB for 25% speed. Off until enabled in the popover for this session.
 *
 * Moves the machine: keep a hand near the stop button when trying it. mods.json settings ("jog"):
 *   keyboardEnabled (true), keyboardFeed (1500), keyboardZFeed (600), keyboardDistance (200),
 *   gamepadMaxFeed (3000), gamepadZFeed (800), deadzone (0.2), invertY (false), stepMs (100), requireDeviceTab (true)
 */
(function jog(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, KV, Toggle, Section, SettingsForm, useMachineState } = ui.react;
  rt.register({ name: "jog", version: "0.1.0" });

  interface Settings {
    keyboardEnabled: boolean;
    keyboardFeed: number;
    keyboardZFeed: number;
    keyboardDistance: number;
    gamepadMaxFeed: number;
    gamepadZFeed: number;
    deadzone: number;
    invertY: boolean;
    stepMs: number;
    requireDeviceTab: boolean;
  }
  let settings: Settings = { keyboardEnabled: true, keyboardFeed: 1500, keyboardZFeed: 600, keyboardDistance: 200, gamepadMaxFeed: 3000, gamepadZFeed: 800, deadzone: 0.2, invertY: false, stepMs: 100, requireDeviceTab: true };
  async function loadSettings(): Promise<void> {
    const r = await window.usermod.info();
    if (!r.ok) return;
    const m = r.data.config.settings["jog"] ?? {};
    const n = (v: unknown, d: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    settings = {
      keyboardEnabled: m.keyboardEnabled !== false,
      keyboardFeed: n(m.keyboardFeed, 1500),
      keyboardZFeed: n(m.keyboardZFeed, 600),
      keyboardDistance: n(m.keyboardDistance, 200),
      gamepadMaxFeed: n(m.gamepadMaxFeed, 3000),
      gamepadZFeed: n(m.gamepadZFeed, 800),
      deadzone: Math.min(0.9, n(m.deadzone, 0.2)),
      invertY: m.invertY === true,
      stepMs: Math.max(50, n(m.stepMs, 100)),
      requireDeviceTab: m.requireDeviceTab !== false
    };
    if (gamepadTimer) startGamepad(); // pick up a new interval
  }
  void loadSettings();

  /* ------------------------------------------------------------- engine */
  const fmt = (n: number): string => (Math.round(n * 1000) / 1000).toString();
  const send = (payload: string): Promise<NestStudio.Result<unknown>> => window.api.device.sendMessage({ type: "text", payload });
  let machine: Usermod.MachineState | null = null;
  window.usermod.on<Usermod.MachineState>("machine:state", (s) => (machine = s));
  type Source = "keyboard" | "gamepad" | null;
  let active: Source = null;
  const live = { blocked: "", feed: 0, sent: 0 };
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((l) => l());

  /** Empty string when jogging is allowed, otherwise the reason it is not. */
  function blocked(): string {
    if (settings.requireDeviceTab && !window.location.hash.startsWith("#/device")) return "not on the Device tab";
    if (!machine) return "machine-state mod off";
    if (!machine.connected) return "no machine connected";
    if (machine.phase === "alarm") return "machine alarm";
    if (machine.phase === "paused") return "program held";
    if (machine.phase === "running" && machine.status !== "Jog") return "program running";
    return "";
  }
  function jogSegment(source: Source, dx: number, dy: number, dz: number, feed: number): void {
    const why = blocked();
    live.blocked = why;
    if (why) {
      stop();
      notify();
      return;
    }
    active = source;
    live.feed = Math.round(feed);
    live.sent += 1;
    void send(`$J=G21G91X${fmt(dx)}Y${fmt(dy)}Z${fmt(dz)}F${fmt(Math.round(feed))}`).then((r) => {
      if (!r.ok) {
        active = null;
        rt.toast(`Jog failed: ${r.message ?? r.code ?? "send error"}`, { kind: "error" });
      }
    });
    notify();
  }
  function stop(force = false): void {
    if (!active && !force) return;
    active = null;
    live.feed = 0;
    void send("0x85");
    notify();
  }
  window.addEventListener("blur", () => stop());
  rt.onRoute(() => stop());

  /* ----------------------------------------------------------- keyboard */
  const AXES: Record<string, [axis: "X" | "Y" | "Z", sign: 1 | -1]> = { ArrowRight: ["X", 1], ArrowLeft: ["X", -1], ArrowUp: ["Y", 1], ArrowDown: ["Y", -1], PageUp: ["Z", 1], PageDown: ["Z", -1] };
  let heldKey: string | null = null;
  const typing = (): boolean => {
    const el = document.activeElement;
    return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  };
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && active) {
        stop();
        heldKey = null;
        return;
      }
      const map = AXES[e.key];
      if (!map || !settings.keyboardEnabled || e.ctrlKey || e.altKey || e.metaKey || typing()) return;
      if (blocked()) return; // let the app have the key when we would refuse anyway
      e.preventDefault();
      if (e.repeat || heldKey) return;
      const [axis, sign] = map;
      const d = sign * settings.keyboardDistance;
      heldKey = e.key;
      // One long segment; the release sends the cancel, exactly like the app's own hold-to-jog buttons.
      jogSegment("keyboard", axis === "X" ? d : 0, axis === "Y" ? d : 0, axis === "Z" ? d : 0, axis === "Z" ? settings.keyboardZFeed : settings.keyboardFeed);
    },
    true
  );
  window.addEventListener(
    "keyup",
    (e: KeyboardEvent) => {
      if (e.key === heldKey) {
        heldKey = null;
        stop();
      }
    },
    true
  );

  /* ------------------------------------------------------------ gamepad */
  let gamepadEnabled = false;
  let gamepadTimer: ReturnType<typeof setInterval> | null = null;
  const pad = { id: "", x: 0, y: 0, z: 0 };
  const shape = (v: number): number => {
    const a = Math.abs(v);
    if (a < settings.deadzone) return 0;
    const t = (a - settings.deadzone) / (1 - settings.deadzone);
    return Math.sign(v) * t * t; // squared for fine control near the centre
  };
  let lastA = false;
  let lastB = false;
  const pads = (): Gamepad[] => Array.from(navigator.getGamepads()).filter((p): p is Gamepad => p !== null && p.connected);
  function gamepadTick(): void {
    const gp = pads()[0];
    pad.id = gp ? `${gp.id} (${gp.axes.length} axes, ${gp.buttons.length} buttons)` : "";
    if (!gp) {
      if (active === "gamepad") stop();
      notify();
      return;
    }
    const a = gp.buttons[0]?.pressed === true;
    const b = gp.buttons[1]?.pressed === true;
    if (a && !lastA) stop(true);
    if (b && !lastB) void send("!");
    lastA = a;
    lastB = b;
    const slow = gp.buttons[4]?.pressed === true;
    const x = shape(gp.axes[0] ?? 0);
    const y = shape(gp.axes[1] ?? 0) * (settings.invertY ? 1 : -1);
    const trigger = (gp.buttons[7]?.value ?? 0) - (gp.buttons[6]?.value ?? 0); // RT up, LT down
    const z = shape(Math.abs(trigger) > 0.05 ? trigger : -(gp.axes[3] ?? 0));
    pad.x = x;
    pad.y = y;
    pad.z = z;
    if (x === 0 && y === 0 && z === 0) {
      if (active === "gamepad") stop();
      live.blocked = blocked();
      notify();
      return;
    }
    if (active === "keyboard") return; // a held key owns the motion
    const scale = slow ? 0.25 : 1;
    const mag = Math.min(1, Math.hypot(x, y, z));
    const feed = Math.max(10, (z !== 0 && x === 0 && y === 0 ? settings.gamepadZFeed : settings.gamepadMaxFeed) * mag * scale);
    // Slightly more than one interval of travel per segment so the planner never starves between commands.
    const dist = (feed / 60) * (settings.stepMs / 1000) * 1.6;
    jogSegment("gamepad", (x / (mag || 1)) * dist, (y / (mag || 1)) * dist, (z / (mag || 1)) * dist * (settings.gamepadZFeed / settings.gamepadMaxFeed), feed);
  }
  function startGamepad(): void {
    if (gamepadTimer) clearInterval(gamepadTimer);
    gamepadTimer = setInterval(gamepadTick, settings.stepMs);
  }
  function setGamepadEnabled(on: boolean): void {
    gamepadEnabled = on;
    if (gamepadTimer) clearInterval(gamepadTimer);
    gamepadTimer = null;
    if (active === "gamepad") stop();
    if (on) startGamepad();
    notify();
  }
  window.addEventListener("gamepadconnected", (e: GamepadEvent) => rt.toast(`Controller connected: ${e.gamepad.id}`, { kind: "info" }));

  /* ------------------------------------------------------------------ UI */
  function Panel(): React.JSX.Element {
    const [, force] = React.useState(0);
    const state = useMachineState();
    React.useEffect(() => {
      const l = (): void => force((n) => n + 1);
      listeners.add(l);
      const poll = setInterval(l, 250);
      return () => {
        listeners.delete(l);
        clearInterval(poll);
      };
    }, []);
    const connected = pads();
    const why = blocked();
    return (
      <>
        <h3>Jog</h3>
        <KV
          pairs={[
            ["Machine", state ? `${state.status ?? "—"} · G${state.wcs ?? "?"}${state.wpos ? ` · X ${state.wpos.x} Y ${state.wpos.y} Z ${state.wpos.z}` : ""}` : "machine-state mod off"],
            ["Jogging", active ? `${active} · ${live.feed} mm/min` : why ? `blocked: ${why}` : "ready"]
          ]}
        />
        <Row>
          <Button label="Stop (0x85)" onClick={() => stop(true)} />
        </Row>
        <Section title="Keyboard">
          <Sub>Arrows move X/Y, PageUp/PageDown move Z while held; Escape stops. Not while typing in a field.</Sub>
          <Toggle
            label="Keyboard jog"
            checked={settings.keyboardEnabled}
            onChange={(on) => {
              settings = { ...settings, keyboardEnabled: on };
              void window.usermod.setSettings("jog", { ...settings });
              force((n) => n + 1);
            }}
          />
        </Section>
        <Section title="Game controller">
          <Toggle label="Controller jog (this session)" checked={gamepadEnabled} onChange={setGamepadEnabled} disabled={!connected.length} />
          <KV
            pairs={[
              ["Controller", connected.length ? pad.id || connected[0]!.id : "none detected (press a button on it)"],
              ["Sticks", `X ${pad.x.toFixed(2)}  Y ${pad.y.toFixed(2)}  Z ${pad.z.toFixed(2)}`]
            ]}
          />
          <Sub>Left stick X/Y · right stick or triggers Z · A stop · B feed hold · hold LB for 25% speed.</Sub>
        </Section>
        <SettingsForm
          modName="jog"
          title="Settings"
          reloadPostprocessors={false}
          onSaved={loadSettings}
          fields={[
            { key: "keyboardFeed", label: "Keyboard X/Y feed (mm/min)", type: "number", min: 10, step: 50 },
            { key: "keyboardZFeed", label: "Keyboard Z feed (mm/min)", type: "number", min: 10, step: 50 },
            { key: "keyboardDistance", label: "Keyboard segment length (mm)", type: "number", min: 1, step: 10 },
            { key: "gamepadMaxFeed", label: "Controller max X/Y feed (mm/min)", type: "number", min: 100, step: 100 },
            { key: "gamepadZFeed", label: "Controller max Z feed (mm/min)", type: "number", min: 50, step: 50 },
            { key: "deadzone", label: "Stick deadzone (0–0.9)", type: "number", min: 0, max: 0.9, step: 0.05 },
            { key: "invertY", label: "Invert controller Y", type: "boolean" },
            { key: "stepMs", label: "Controller command interval (ms)", type: "number", min: 50, max: 500, step: 10 },
            { key: "requireDeviceTab", label: "Only on the Device tab", type: "boolean" }
          ]}
        />
      </>
    );
  }
  ui.toolbar.addButton({
    id: "jog",
    title: "Jog",
    icon: () => ui.icons.svg("M7 6h10a5 5 0 0 1 4.9 6l-1 5.2a2.5 2.5 0 0 1-4.3 1.2L14.6 16H9.4l-2 2.4a2.5 2.5 0 0 1-4.3-1.2l-1-5.2A5 5 0 0 1 7 6zm0 3v2H5v2h2v2h2v-2h2v-2H9V9H7zm9 0a1.2 1.2 0 1 0 0 2.4A1.2 1.2 0 0 0 16 9zm2.5 2.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"),
    order: 46,
    onClick: (button) => {
      ui.react.popover(button, <Panel />, { width: 420 });
    }
  });
})();
