/*
 * Work zero: where the program's origin sits, and how to set it.
 *
 * Offsets: the active coordinate system (G54-G59), live machine and work positions, set-zero-here, and
 * named machine positions with go-to. Probe: the touch-plate wizard that sets work Z from a plate thickness.
 *
 * One toolbar icon opens a window with a tab per feature. Each feature keeps its own scope (a nested
 * function), so the code is the same as when they were separate mods; only the entry point is shared.
 * mods.json settings ("work-zero"): travelRetract, confirmGoTo, positions, plateThickness, probeFeed, fastFeed, twoStage, maxTravel, retract, timeoutSeconds
 */
(function workZero(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "work-zero", version: "0.1.0" });

  /** A tab renders into `body` and may return a cleanup function (React panels return their unmount). */
  interface Tab {
    id: string;
    label: string;
    open(body: HTMLElement, close: () => void): void | (() => void);
  }
  const tabs: Tab[] = [];

  (function feature(): void {
      const rt = window.usermodRuntime;
      const ui = window.usermodUI;
      const { Sub, Row, Button, KV, Input, Toggle, Section, Err, useMachineState, useInfo } = ui.react;

      interface Position {
        name: string;
        x: number;
        y: number;
        z: number;
      }
      interface Settings {
        positions: Position[];
        travelRetract: string;
        confirmGoTo: boolean;
      }
      const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      function parseSettings(raw: Record<string, unknown> | undefined): Settings {
        const list: unknown = raw?.positions;
        const positions: Position[] = Array.isArray(list)
          ? list.flatMap((p: unknown) => (isRecord(p) && typeof p.name === "string" && [p.x, p.y, p.z].every((v) => typeof v === "number" && Number.isFinite(v)) ? [{ name: p.name, x: Number(p.x), y: Number(p.y), z: Number(p.z) }] : []))
          : [];
        return { positions, travelRetract: typeof raw?.travelRetract === "string" && raw.travelRetract ? raw.travelRetract : "G53 G90 G0 Z-1", confirmGoTo: raw?.confirmGoTo !== false };
      }
      const fmt = (n: number): string => (Math.round(n * 1000) / 1000).toString();

      async function send(...commands: string[]): Promise<void> {
        for (const c of commands) {
          const r = await window.api.device.sendMessage({ type: "text", payload: c });
          if (!r.ok) throw new Error(`${c}: ${r.message ?? r.code ?? "send failed"}`);
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }
      function requireIdle(state: Usermod.MachineState | null): void {
        if (!state) throw new Error("machine-state mod is not running");
        if (!state.connected) throw new Error("No machine connected");
        if (state.phase === "running" || state.phase === "paused") throw new Error("Machine is busy");
        if (state.phase === "alarm") throw new Error(`Machine alarm: ${state.alarm ?? "unlock first"}`);
      }

      function GoToConfirm({ pos, settings, close }: { pos: Position; settings: Settings; close(): void }): React.JSX.Element {
        const [withZ, setWithZ] = React.useState(false);
        const go = async (): Promise<void> => {
          const commands = [settings.travelRetract, `G53 G90 G0 X${fmt(pos.x)} Y${fmt(pos.y)}`];
          if (withZ) commands.push(`G53 G90 G0 Z${fmt(pos.z)}`);
          await send(...commands);
          rt.toast(`Moving to "${pos.name}"`, { kind: "success" });
          close();
        };
        return (
          <>
            <KV pairs={[["Position", pos.name], ["Machine X / Y / Z", `${fmt(pos.x)} / ${fmt(pos.y)} / ${fmt(pos.z)}`], ["First", settings.travelRetract]]} />
            <Toggle label="Also move Z to the saved height (after X/Y)" checked={withZ} onChange={setWithZ} />
            <Sub>Rapid move in machine coordinates. Make sure nothing is in the way.</Sub>
            <Row>
              <Button label="Go" primary onClick={go} />
              <Button label="Cancel" onClick={close} />
            </Row>
          </>
        );
      }

      function Panel({ closePopover }: { closePopover(): void }): React.JSX.Element {
        const state = useMachineState();
        const { data: info, error, refresh } = useInfo();
        const [newName, setNewName] = React.useState("");
        if (error) return <Err>{error}</Err>;
        const settings = parseSettings(info?.config.settings["work-offsets"]);
        const wcs = state?.wcs ?? null;
        const slot = (wcs ?? 54) - 53;
        const axes = (a: Usermod.MachineAxes | null): string => (a ? `X ${fmt(a.x)}   Y ${fmt(a.y)}   Z ${fmt(a.z)}` : "—");
        const save = async (positions: Position[]): Promise<void> => {
          const r = await window.usermod.setSettings("work-offsets", { ...settings, positions });
          if (!r.ok) throw new Error(r.message);
          await refresh();
        };
        const guarded = (fn: () => Promise<void>) => async (): Promise<void> => {
          requireIdle(state);
          await fn();
        };
        const zeroHere = (words: string): (() => Promise<void>) =>
          guarded(async () => {
            await send(`G10 L20 P${slot} ${words}`);
            rt.toast(`Work zero set (${words}) in G${slot + 53}`, { kind: "success" });
          });
        const addCurrent = guarded(async () => {
          if (!state?.mpos) throw new Error("No machine position reported yet");
          const name = newName.trim() || `Position ${settings.positions.length + 1}`;
          await save([...settings.positions, { name, x: state.mpos.x, y: state.mpos.y, z: state.mpos.z }]);
          setNewName("");
          rt.toast(`Saved "${name}"`, { kind: "success" });
        });
        const goTo = (pos: Position): (() => Promise<void>) =>
          guarded(async () => {
            closePopover();
            if (!settings.confirmGoTo) {
              await send(settings.travelRetract, `G53 G90 G0 X${fmt(pos.x)} Y${fmt(pos.y)}`);
              return;
            }
            let modal: Usermod.ModalHandle | null = null;
            modal = ui.react.modal(`Go to "${pos.name}"?`, <GoToConfirm pos={pos} settings={settings} close={() => modal?.close()} />, { width: 420 });
          });
        const zeroAt = (pos: Position): (() => Promise<void>) =>
          guarded(async () => {
            await send(`G10 L2 P${slot} X${fmt(pos.x)} Y${fmt(pos.y)} Z${fmt(pos.z)}`);
            rt.toast(`G${slot + 53} origin set to "${pos.name}" (no motion)`, { kind: "success" });
          });
        const remove = (pos: Position): (() => Promise<void>) => () => save(settings.positions.filter((p) => p !== pos));

        return (
          <>
            <h3>Work offsets</h3>
            {!state ? <Err>Enable the machine-state mod to see positions.</Err> : null}
            <KV
              pairs={[
                ["Active WCS", wcs ? `G${wcs}` : "—"],
                ["Machine (MPos)", axes(state?.mpos ?? null)],
                ["Work (WPos)", axes(state?.wpos ?? null)],
                ["Status", state?.status ?? "—"]
              ]}
            />
            <Section title="Coordinate system">
              <Row>
                {[54, 55, 56, 57, 58, 59].map((g) => (
                  <Button key={g} label={`G${g}`} primary={wcs === g} onClick={guarded(async () => send(`G${g}`))} />
                ))}
              </Row>
            </Section>
            <Section title="Set work zero here">
              <Row>
                <Button label="XY" onClick={zeroHere("X0 Y0")} />
                <Button label="Z" onClick={zeroHere("Z0")} />
                <Button label="XYZ" onClick={zeroHere("X0 Y0 Z0")} />
                <Sub>{`writes G10 L20 P${slot}`}</Sub>
              </Row>
            </Section>
            <Section title="Saved positions (machine coordinates)">
              {settings.positions.length ? (
                settings.positions.map((pos) => (
                  <div key={pos.name} className="usermod-row" style={{ justifyContent: "space-between" }}>
                    <span>
                      <strong>{pos.name}</strong> <small className="usermod-sub">{`X ${fmt(pos.x)} Y ${fmt(pos.y)} Z ${fmt(pos.z)}`}</small>
                    </span>
                    <span className="usermod-row" style={{ marginTop: 0 }}>
                      <Button label="Go to" onClick={goTo(pos)} title="Retract, then rapid to X/Y in machine coordinates" />
                      <Button label="Zero here" onClick={zeroAt(pos)} title={`Set the G${slot + 53} origin to this position without moving`} />
                      <Button label="✕" onClick={remove(pos)} title="Delete" />
                    </span>
                  </div>
                ))
              ) : (
                <Sub>None yet. Jog to a spot and save it below.</Sub>
              )}
              <Row>
                <Input label="Name" value={newName} onChange={setNewName} placeholder="Vice corner" />
                <Button label="Save current position" primary onClick={addCurrent} disabled={!state?.mpos} />
              </Row>
            </Section>
          </>
        );
      }
    tabs.push({ id: "offsets", label: "Offsets", open: (body, close) => ui.react.mount(body, <Panel closePopover={close} />) });
  })();

  (function feature(): void {
      const rt = window.usermodRuntime;
      const ui = window.usermodUI;
      const { Sub, Row, Button, KV, SettingsForm, Err } = ui.react;

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
      // Offered to other mods (tool-change asks for it when the machine holds at a change).
      ui.provide("probe", { run: () => open(), enabled: () => offer });
    tabs.push({ id: "probe", label: "Probe Z", open: (body, close) => ui.react.mount(body, <Wizard close={close} />) });
  })();


  rt.addStyle(
    `.usermod-tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
     .usermod-tabs .usermod-btn[data-active=true]{background:#0f766e;color:#fff}`,
    "work-zero-tabs"
  );
  function openWindow(startTab = tabs[0]?.id): void {
    const modal = ui.modal("Work zero", { width: 520 });
    const strip = rt.el("div", { class: "usermod-tabs" });
    const body = rt.el("div");
    modal.body.append(strip, body);
    let cleanup: (() => void) | void;
    const show = (id: string): void => {
      const tab = tabs.find((t) => t.id === id) ?? tabs[0];
      if (!tab) return;
      if (typeof cleanup === "function") cleanup();
      body.replaceChildren();
      for (const button of strip.children) if (button instanceof HTMLElement) button.dataset.active = String(button.dataset.tab === tab.id);
      cleanup = tab.open(body, modal.close);
    };
    for (const tab of tabs) {
      const button = ui.button(tab.label, () => show(tab.id));
      button.dataset.tab = tab.id;
      strip.appendChild(button);
    }
    show(startTab ?? "");
  }

  ui.toolbar.addButton({
    id: "work-zero",
    title: "Offsets and probing",
    icon: () => ui.icons.svg("M12 2a1 1 0 0 1 1 1v2.06A7 7 0 0 1 18.94 11H21a1 1 0 1 1 0 2h-2.06A7 7 0 0 1 13 18.94V21a1 1 0 1 1-2 0v-2.06A7 7 0 0 1 5.06 13H3a1 1 0 1 1 0-2h2.06A7 7 0 0 1 11 5.06V3a1 1 0 0 1 1-1zm0 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"),
    order: 43,
    onClick: () => openWindow()
  });
})();
