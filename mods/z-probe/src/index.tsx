/*
 * Z probe: touch-plate wizard. Place the plate on the work under the bit, clip the lead to the bit, run:
 *   G91 → G38.2 Z-<maxTravel> F<fastFeed> → (two-stage: G0 Z1, G38.2 Z-2 F<probeFeed>) → G90
 *   → G10 L20 P<active WCS> Z<plateThickness> → G91 G0 Z<retract> → G90
 * Progress is tracked through the machine-state mod (status Run/Idle, PRB console lines, alarms), so that mod
 * must be on. Any error / alarm line or a failed probe ([PRB:…:0]) aborts and tells you what to do.
 *
 * The firmware must support G38.2 straight probing; the first run should be done with the bit well above
 * the plate and a hand on the stop button. Exposes window.usermodZProbe for other mods (the tool-change
 * assistant offers "Probe Z, then resume").
 *
 * mods.json settings ("z-probe"): plateThickness (10), probeFeed (100), fastFeed (300), twoStage (true),
 *   maxTravel (30), retract (5), timeoutSeconds (60), offerAtToolChange (true)
 */
(function zProbe(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, KV, SettingsForm, Err } = ui.react;
  rt.register({ name: "z-probe", version: "0.1.0" });

  interface Settings {
    plateThickness: number;
    probeFeed: number;
    fastFeed: number;
    twoStage: boolean;
    maxTravel: number;
    retract: number;
    timeoutSeconds: number;
    offerAtToolChange: boolean;
  }
  const DEFAULTS: Settings = { plateThickness: 10, probeFeed: 100, fastFeed: 300, twoStage: true, maxTravel: 30, retract: 5, timeoutSeconds: 60, offerAtToolChange: true };
  async function settings(): Promise<Settings> {
    const r = await window.usermod.info();
    const raw = r.ok ? r.data.config.settings["z-probe"] ?? {} : {};
    const n = (k: keyof Settings, d: number): number => {
      const v = Number(raw[k]);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    return {
      plateThickness: n("plateThickness", DEFAULTS.plateThickness),
      probeFeed: Math.min(1000, n("probeFeed", DEFAULTS.probeFeed)),
      fastFeed: Math.min(1000, n("fastFeed", DEFAULTS.fastFeed)),
      twoStage: raw.twoStage !== false,
      maxTravel: n("maxTravel", DEFAULTS.maxTravel),
      retract: n("retract", DEFAULTS.retract),
      timeoutSeconds: n("timeoutSeconds", DEFAULTS.timeoutSeconds),
      offerAtToolChange: raw.offerAtToolChange !== false
    };
  }
  const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

  /* ------------------------------------------------------- machine helpers */
  type Listener = (line: string) => void;
  async function machine(): Promise<Usermod.MachineState | null> {
    const r = await window.usermod.invoke<Usermod.MachineState>("machine:state");
    return r.ok ? r.data : null;
  }
  async function send(text: string, log: Listener): Promise<void> {
    log(`> ${text}`);
    const r = await window.api.device.sendMessage({ type: "text", payload: text });
    if (!r.ok) throw new Error(`${text}: ${r.message ?? r.code ?? "send failed"}`);
  }
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  class Aborted extends Error {}
  /** Waits for a motion to start (status Run/Jog/Home, up to graceMs) and then finish (Idle). Alarms and error lines throw. */
  async function waitMotion(timeoutMs: number, aborted: () => boolean, errorLine: () => string | null, graceMs = 2000): Promise<void> {
    const started = Date.now();
    let sawRun = false;
    while (Date.now() - started < timeoutMs) {
      if (aborted()) throw new Aborted("aborted");
      const err = errorLine();
      if (err) throw new Error(err);
      const s = await machine();
      if (!s) throw new Error("machine-state mod is not running");
      if (s.phase === "alarm") throw new Error(`Machine alarm: ${s.alarm ?? "unknown"}. Clear it ($X) and probe again.`);
      const running = s.status === "Run" || s.status === "Jog" || s.status === "Home";
      if (running) sawRun = true;
      else if (s.status === "Idle" || s.status === "Ready") {
        if (sawRun || Date.now() - started > graceMs) return;
      }
      await sleep(150);
    }
    throw new Error("Timed out waiting for the machine");
  }

  interface RunOptions {
    log: Listener;
    aborted(): boolean;
  }
  async function runProbe({ log, aborted }: RunOptions): Promise<number> {
    const s = await settings();
    const state = await machine();
    if (!state) throw new Error("The machine-state mod must be enabled for probing.");
    if (!state.connected) throw new Error("No machine connected.");
    if (state.phase === "alarm") throw new Error(`Machine is in alarm (${state.alarm ?? "unknown"}); unlock first.`);
    if (state.phase === "running") throw new Error("Machine is busy; wait until it is idle.");
    const wcs = (state.wcs ?? 54) - 53;
    let lastError: string | null = null;
    let probeResult: string | null = null;
    const off = window.usermod.on<Usermod.MachineConsoleLine>("machine:console", (c) => {
      log(`< ${c.line}`);
      if (c.kind === "probe") probeResult = c.line;
      if (c.kind === "error" || c.kind === "alarm") lastError = c.line;
    });
    const timeout = s.timeoutSeconds * 1000;
    const errorLine = (): string | null => lastError;
    const probeOnce = async (travel: number, feed: number): Promise<void> => {
      probeResult = null;
      await send(`G38.2 Z-${fmt(travel)} F${fmt(feed)}`, log);
      await waitMotion(timeout, aborted, errorLine);
      if (probeResult && /:0\]/.test(probeResult)) throw new Error("Probe did not touch the plate within the travel distance. Check the clip and the plate, then retry.");
    };
    try {
      log(`Probing with plate ${s.plateThickness} mm, WCS G${wcs + 53}`);
      await send("G91", log);
      await probeOnce(s.maxTravel, s.fastFeed);
      if (s.twoStage) {
        await send("G0 Z1", log);
        await waitMotion(timeout, aborted, errorLine);
        await probeOnce(2.5, s.probeFeed);
      }
      await send("G90", log);
      await send(`G10 L20 P${wcs} Z${fmt(s.plateThickness)}`, log);
      await sleep(200);
      if (lastError) throw new Error(lastError);
      await send(`G91 G0 Z${fmt(s.retract)}`, log);
      await waitMotion(timeout, aborted, errorLine);
      await send("G90", log);
      log(`Done: work Z zero set, bit is ${fmt(s.plateThickness + s.retract)} mm above the surface.`);
      return s.plateThickness;
    } catch (error) {
      // Leave the controller in absolute mode whatever happened.
      await window.api.device.sendMessage({ type: "text", payload: "G90" }).catch(() => undefined);
      throw error;
    } finally {
      off();
    }
  }

  /* ------------------------------------------------------------------- UI */
  function Wizard({ close, onDone }: { close(): void; onDone?(): void }): React.JSX.Element {
    const [lines, setLines] = React.useState<string[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [done, setDone] = React.useState(false);
    const abortRef = React.useRef(false);
    const start = async (): Promise<void> => {
      setBusy(true);
      setError(null);
      setDone(false);
      abortRef.current = false;
      setLines([]);
      try {
        await runProbe({ log: (l) => setLines((prev) => [...prev, l]), aborted: () => abortRef.current });
        setDone(true);
        rt.toast("Z zero set from the touch plate", { kind: "success" });
        onDone?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
    const abort = async (): Promise<void> => {
      abortRef.current = true;
      await window.api.device.sendMessage({ type: "text", payload: "!" }); // feed hold; the operator resumes or resets from the app
      setLines((prev) => [...prev, "> ! (feed hold sent; use the app's Resume or Reset)"]);
    };
    return (
      <>
        <Sub>Place the touch plate on the work directly under the bit and clip the lead to the bit. The bit must be within the max travel above the plate. Keep a hand on the stop button for the first run.</Sub>
        <Row>
          <Button label={done ? "Probe again" : "Start probing"} primary disabled={busy} onClick={start} />
          <Button label="Abort (feed hold)" disabled={!busy} onClick={abort} />
          <Button label="Close" onClick={close} />
        </Row>
        {error ? <Err>{error}</Err> : null}
        {lines.length ? <div className="usermod-mono" style={{ marginTop: 8 }}>{lines.join("\n")}</div> : null}
        <SettingsForm
          modName="z-probe"
          title="Settings"
          reloadPostprocessors={false}
          fields={[
            { key: "plateThickness", label: "Plate thickness (mm)", type: "number", min: 0, step: 0.01 },
            { key: "fastFeed", label: "First probe feed (mm/min, max 1000)", type: "number", min: 10, max: 1000, step: 10 },
            { key: "twoStage", label: "Second, slow probe for accuracy", type: "boolean" },
            { key: "probeFeed", label: "Slow probe feed (mm/min)", type: "number", min: 5, max: 1000, step: 5 },
            { key: "maxTravel", label: "Max probe travel (mm)", type: "number", min: 1, step: 1 },
            { key: "retract", label: "Retract after probing (mm)", type: "number", min: 0, step: 1 },
            { key: "timeoutSeconds", label: "Timeout per move (s)", type: "number", min: 5, step: 5 },
            { key: "offerAtToolChange", label: "Offer probing in the tool-change dialog", type: "boolean" }
          ]}
        />
      </>
    );
  }
  function open(onDone?: () => void): Promise<void> {
    return new Promise((resolve) => {
      let modal: Usermod.ModalHandle | null = null;
      modal = ui.react.modal("Z probe", <Wizard close={() => modal?.close()} onDone={onDone} />, { width: 520, onClose: () => resolve() });
    });
  }

  let offer = DEFAULTS.offerAtToolChange;
  void settings().then((s) => (offer = s.offerAtToolChange));
  window.usermodZProbe = { run: () => open(), enabled: () => offer };
  ui.toolbar.addButton({ id: "z-probe", title: "Probe Z with a touch plate", icon: () => ui.icons.svg("M11 2h2v11.2l3.3-3.3 1.4 1.4L12 17.4l-5.7-6.1 1.4-1.4L11 13.2V2zM4 19h16v3H4v-3z"), order: 44, onClick: () => void open() });
})();
