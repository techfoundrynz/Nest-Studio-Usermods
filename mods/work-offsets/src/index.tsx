/*
 * Work offsets: a toolbar popover for the coordinate systems the firmware already supports.
 *   - shows the active WCS (G54–G59), machine (MPos) and work (WPos) positions live (machine-state mod)
 *   - switch WCS: sends G54…G59
 *   - set work zero here (XY / Z / XYZ): G10 L20 P<n> X0 Y0 Z0, exactly what the app's own zero buttons send
 *   - named positions (machine coordinates) saved in mods.json: Save current, Go to (retract first, then
 *     G53 rapid, with confirmation), Zero here (G10 L2 P<n> X Y Z sets the active WCS origin without moving)
 *
 * Motion commands are refused unless the machine is idle. mods.json settings ("work-offsets"):
 *   positions: [{ name, x, y, z }], travelRetract ("G53 G90 G0 Z-1"), confirmGoTo (true)
 */
(function workOffsets(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, KV, Input, Toggle, Section, Err, useMachineState, useInfo } = ui.react;
  rt.register({ name: "work-offsets", version: "0.1.0" });

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

  ui.toolbar.addButton({
    id: "work-offsets",
    title: "Work offsets",
    icon: () => ui.icons.svg("M12 2a1 1 0 0 1 1 1v2.06A7 7 0 0 1 18.94 11H21a1 1 0 1 1 0 2h-2.06A7 7 0 0 1 13 18.94V21a1 1 0 1 1-2 0v-2.06A7 7 0 0 1 5.06 13H3a1 1 0 1 1 0-2h2.06A7 7 0 0 1 11 5.06V3a1 1 0 0 1 1-1zm0 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"),
    order: 43,
    onClick: (button) => {
      let pop: Usermod.PopoverHandle | null = null;
      pop = ui.react.popover(button, <Panel closePopover={() => pop?.close()} />, { width: 440 });
    }
  });
})();
