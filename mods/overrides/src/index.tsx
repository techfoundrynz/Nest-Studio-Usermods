/*
 * Live override: feed and spindle overrides while a job runs. This machine does not use GRBL's relative
 * override bytes; its firmware takes absolute percentages as text commands, exactly as the app's own Device
 * tab sends them:
 *   feed     0xC0 = 0% … 0xCA = 100% … 0xCF = 150%   (steps of 10)
 *   spindle  0xD0 = 50% … 0xD5 = 100% … 0xD7 = 120%  (steps of 10)
 * The same values are available on the Device tab; this mod puts them one click away from any tab and shows
 * the live feed and spindle the machine reports back, so you can confirm the change landed.
 *
 * 0% feed is deliberately not offered: use the app's pause / feed hold for that.
 */
(function liveOverride(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, KV, useMachineState } = ui.react;
  rt.register({ name: "overrides", version: "0.2.0" });

  rt.addStyle(
    `.usermod-ov-row{display:grid;grid-template-columns:64px 1fr;align-items:center;gap:8px;margin:8px 0}
     .usermod-ov-row .usermod-row{margin-top:0}
     .usermod-ov-row .usermod-btn[data-active=true]{background:#0f766e;color:#fff}`,
    "overrides"
  );

  /** Percentage -> command, copied from the app's own FEED_RATE_COMMAND_MAP / SPINDLE_RATE_COMMAND_MAP. */
  const FEED: Record<number, string> = { 0: "0xC0", 10: "0xC1", 20: "0xC2", 30: "0xC3", 40: "0xC4", 50: "0xC5", 60: "0xC6", 70: "0xC7", 80: "0xC8", 90: "0xC9", 100: "0xCA", 110: "0xCB", 120: "0xCC", 130: "0xCD", 140: "0xCE", 150: "0xCF" };
  const SPINDLE: Record<number, string> = { 50: "0xD0", 60: "0xD1", 70: "0xD2", 80: "0xD3", 90: "0xD4", 100: "0xD5", 110: "0xD6", 120: "0xD7" };
  const FEED_STEPS = [10, 25, 50, 75, 100, 125, 150].map((p) => (p in FEED ? p : Math.round(p / 10) * 10));
  const SPINDLE_STEPS = [50, 60, 70, 80, 90, 100, 110, 120];

  async function send(command: string): Promise<void> {
    const r = await window.api.device.sendMessage({ type: "text", payload: command });
    if (!r.ok) throw new Error(r.message ?? r.code ?? "send failed");
  }

  function Panel(): React.JSX.Element {
    const state = useMachineState();
    // The firmware does not report the override percentages, so remember what we last asked for.
    const [feed, setFeed] = React.useState<number | null>(null);
    const [spindle, setSpindle] = React.useState<number | null>(null);
    const connected = state?.connected === true;
    const apply = (map: Record<number, string>, pct: number, remember: (p: number) => void) => async (): Promise<void> => {
      const command = map[pct];
      if (!command) throw new Error(`${pct}% is not one of the machine's steps`);
      await send(command);
      remember(pct);
      rt.toast(`Sent ${pct}%`, { kind: "success", duration: 1500 });
    };
    return (
      <>
        <h3>Live override</h3>
        <Sub>Absolute percentages, applied immediately to the running program. These are the same commands the Device tab sends.</Sub>
        <div className="usermod-ov-row">
          <strong>Feed</strong>
          <Row>
            {FEED_STEPS.map((p) => (
              <button key={p} type="button" className="usermod-btn" data-active={feed === p} disabled={!connected} onClick={() => void apply(FEED, p, setFeed)().catch((e: unknown) => rt.toast(e instanceof Error ? e.message : String(e), { kind: "error" }))}>
                {`${p}%`}
              </button>
            ))}
          </Row>
        </div>
        <div className="usermod-ov-row">
          <strong>Spindle</strong>
          <Row>
            {SPINDLE_STEPS.map((p) => (
              <button key={p} type="button" className="usermod-btn" data-active={spindle === p} disabled={!connected} onClick={() => void apply(SPINDLE, p, setSpindle)().catch((e: unknown) => rt.toast(e instanceof Error ? e.message : String(e), { kind: "error" }))}>
                {`${p}%`}
              </button>
            ))}
          </Row>
        </div>
        <Row>
          <Button label="Feed 100%" disabled={!connected} onClick={apply(FEED, 100, setFeed)} />
          <Button label="Spindle 100%" disabled={!connected} onClick={apply(SPINDLE, 100, setSpindle)} />
        </Row>
        <KV
          pairs={[
            ["Machine", state ? `${state.status ?? "—"}${state.phase === "running" ? ` · line ${state.line ?? "?"}` : ""}` : "machine-state mod off"],
            ["Live feed", state?.feed !== null && state?.feed !== undefined ? `${state.feed} mm/min` : "—"],
            ["Live spindle", state?.spindle !== null && state?.spindle !== undefined ? `${state.spindle} rpm` : "—"],
            ["Last sent", `feed ${feed === null ? "—" : `${feed}%`} · spindle ${spindle === null ? "—" : `${spindle}%`}`]
          ]}
        />
        <Sub>Watch the live feed to confirm a change took effect. The machine keeps the override until you change it or a new job starts.</Sub>
      </>
    );
  }

  ui.toolbar.addButton({
    id: "overrides",
    title: "Feed override",
    icon: () => ui.icons.svg("M12 3a9 9 0 0 0-9 9 8.96 8.96 0 0 0 2.64 6.36l1.41-1.41A6.98 6.98 0 0 1 5 12a7 7 0 0 1 14 0c0 1.93-.78 3.68-2.05 4.95l1.41 1.41A8.96 8.96 0 0 0 21 12a9 9 0 0 0-9-9zm0 5-3.5 6.5a2.5 2.5 0 1 0 4.24 1.06L12 8z"),
    order: 42,
    onClick: (button) => {
      ui.react.popover(button, <Panel />, { width: 430 });
    }
  });
})();
