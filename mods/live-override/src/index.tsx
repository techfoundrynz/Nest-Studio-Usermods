/*
 * Live override: feed, rapid and spindle overrides while a job runs, using GRBL's realtime override
 * commands (0x90–0x9D). The app sends its own realtime jog-cancel as the text "0x85", so the same spelling is
 * used here by default; "raw" sends the actual byte instead. The firmware must support these commands: watch
 * the live feed value (from the status frame's FS field) after pressing +10% to confirm it took effect.
 *
 * mods.json settings ("live-override"): format ("hex-text" | "raw", default "hex-text")
 */
(function liveOverride(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, KV, useMachineState, useInfo } = ui.react;
  rt.register({ name: "live-override", version: "0.1.0" });

  rt.addStyle(
    `.usermod-ov-pct{min-width:52px;text-align:center;font-weight:600;font-size:14px}
     .usermod-ov-row{display:grid;grid-template-columns:70px 1fr;align-items:center;gap:8px;margin:8px 0}
     .usermod-ov-row .usermod-row{margin-top:0}`,
    "live-override"
  );

  const CODES = {
    feedReset: 0x90,
    feedPlus10: 0x91,
    feedMinus10: 0x92,
    feedPlus1: 0x93,
    feedMinus1: 0x94,
    rapid100: 0x95,
    rapid50: 0x96,
    rapid25: 0x97,
    spindleReset: 0x99,
    spindlePlus10: 0x9a,
    spindleMinus10: 0x9b,
    spindlePlus1: 0x9c,
    spindleMinus1: 0x9d
  } as const;
  type Code = keyof typeof CODES;

  async function send(code: Code, format: string): Promise<void> {
    const byte = CODES[code];
    const payload = format === "raw" ? String.fromCharCode(byte) : `0x${byte.toString(16).toUpperCase()}`;
    const r = await window.api.device.sendMessage({ type: "text", payload });
    if (!r.ok) throw new Error(r.message ?? r.code ?? "send failed");
  }
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

  function Panel(): React.JSX.Element {
    const state = useMachineState();
    const { data: info } = useInfo();
    const format = String(info?.config.settings["live-override"]?.format ?? "hex-text");
    // The firmware does not echo override percentages in the parsed status frame, so keep a local estimate.
    const [feed, setFeed] = React.useState(100);
    const [rapid, setRapid] = React.useState(100);
    const [spindle, setSpindle] = React.useState(100);
    const connected = state?.connected === true;
    const act = (code: Code, apply: () => void) => async (): Promise<void> => {
      await send(code, format);
      apply();
    };
    const group = (label: string, pct: number, codes: { reset: Code; p10: Code; m10: Code; p1: Code; m1: Code }, set: (f: (v: number) => number) => void): React.ReactNode => (
      <div className="usermod-ov-row">
        <strong>{label}</strong>
        <Row>
          <Button label="−10" disabled={!connected} onClick={act(codes.m10, () => set((v) => clamp(v - 10, 10, 200)))} />
          <Button label="−1" disabled={!connected} onClick={act(codes.m1, () => set((v) => clamp(v - 1, 10, 200)))} />
          <span className="usermod-ov-pct">{pct}%</span>
          <Button label="+1" disabled={!connected} onClick={act(codes.p1, () => set((v) => clamp(v + 1, 10, 200)))} />
          <Button label="+10" disabled={!connected} onClick={act(codes.p10, () => set((v) => clamp(v + 10, 10, 200)))} />
          <Button label="100%" disabled={!connected} onClick={act(codes.reset, () => set(() => 100))} />
        </Row>
      </div>
    );
    return (
      <>
        <h3>Live override</h3>
        <Sub>Realtime commands, applied immediately to the running program. Percentages are estimates; the live feed below is what the machine reports.</Sub>
        {group("Feed", feed, { reset: "feedReset", p10: "feedPlus10", m10: "feedMinus10", p1: "feedPlus1", m1: "feedMinus1" }, (f) => setFeed(f))}
        {group("Spindle", spindle, { reset: "spindleReset", p10: "spindlePlus10", m10: "spindleMinus10", p1: "spindlePlus1", m1: "spindleMinus1" }, (f) => setSpindle(f))}
        <div className="usermod-ov-row">
          <strong>Rapids</strong>
          <Row>
            {([25, 50, 100] as const).map((p) => (
              <Button key={p} label={`${p}%`} primary={rapid === p} disabled={!connected} onClick={act(p === 25 ? "rapid25" : p === 50 ? "rapid50" : "rapid100", () => setRapid(p))} />
            ))}
          </Row>
        </div>
        <KV
          pairs={[
            ["Machine", state ? `${state.status ?? "—"}${state.phase === "running" ? ` · line ${state.line ?? "?"}` : ""}` : "machine-state mod off"],
            ["Live feed", state?.feed !== null && state?.feed !== undefined ? `${state.feed} mm/min` : "—"],
            ["Live spindle", state?.spindle !== null && state?.spindle !== undefined ? `${state.spindle} rpm` : "—"],
            ["Command format", format === "raw" ? "raw byte" : 'text "0x9x" (like the app\'s jog cancel)']
          ]}
        />
      </>
    );
  }

  ui.toolbar.addButton({
    id: "live-override",
    title: "Feed / spindle override",
    icon: () => ui.icons.svg("M12 3a9 9 0 0 0-9 9 8.96 8.96 0 0 0 2.64 6.36l1.41-1.41A6.98 6.98 0 0 1 5 12a7 7 0 0 1 14 0c0 1.93-.78 3.68-2.05 4.95l1.41 1.41A8.96 8.96 0 0 0 21 12a9 9 0 0 0-9-9zm0 5-3.5 6.5a2.5 2.5 0 1 0 4.24 1.06L12 8z"),
    order: 42,
    onClick: (button) => {
      ui.react.popover(button, <Panel />, { width: 420 });
    }
  });
})();
