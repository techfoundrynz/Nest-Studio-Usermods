/*
 * Device macros: user-defined buttons that send G-code / controller commands through the app's own device
 * channel (window.api.device.sendMessage), one line at a time. Macros live in mods.json:
 *
 *   "device-macros": { "confirmAll": false, "macros": [
 *     { "name": "Safe Z", "lines": ["G53 G90 G0 Z-1"], "confirm": true }, ... ] }
 *
 * and can be edited in the popover (React, via the kit). Macros move the machine: every macro with
 * "confirm": true (or confirmAll) asks first.
 */
(function deviceMacros(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, Toggle, Input, Mono, Loading, Err, useInfo } = ui.react;
  rt.register({ name: "device-macros", version: "0.2.0" });

  interface Macro {
    name: string;
    lines: string[];
    confirm: boolean;
  }
  interface Settings {
    confirmAll: boolean;
    macros: Macro[];
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  function parseSettings(raw: Record<string, unknown> | undefined): Settings {
    const list: unknown = raw?.macros;
    const macros: Macro[] = Array.isArray(list)
      ? list.flatMap((m: unknown) => {
          if (!isRecord(m)) return [];
          const lines = Array.isArray(m.lines) ? m.lines.filter((l): l is string => typeof l === "string" && l.trim() !== "") : [];
          return typeof m.name === "string" && lines.length ? [{ name: m.name, lines, confirm: m.confirm === true }] : [];
        })
      : [];
    return { confirmAll: raw?.confirmAll === true, macros };
  }

  async function connected(): Promise<boolean> {
    try {
      const r = await window.api.device.getStatus();
      return r.ok && r.data.connected === true;
    } catch {
      return false;
    }
  }
  async function run(macro: Macro): Promise<void> {
    if (!(await connected())) {
      rt.toast("No machine connected", { kind: "warn" });
      return;
    }
    for (const line of macro.lines) {
      const r = await window.api.device.sendMessage({ type: "text", payload: line });
      if (!r.ok) throw new Error(`${line}: ${r.message ?? r.code ?? "send failed"}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    rt.toast(`Macro "${macro.name}" sent (${macro.lines.length} line${macro.lines.length === 1 ? "" : "s"})`, { kind: "success" });
    rt.log("info", `macro ${macro.name}: ${macro.lines.join(" | ")}`);
  }
  function confirmThenRun(macro: Macro, confirmAll: boolean): void {
    if (!(macro.confirm || confirmAll)) {
      void run(macro);
      return;
    }
    const modal = ui.react.modal(
      `Run macro "${macro.name}"?`,
      <>
        <Mono>{macro.lines.join("\n")}</Mono>
        <Sub>This is sent to the connected machine exactly as shown.</Sub>
        <Row>
          <Button
            label="Send"
            primary
            onClick={async () => {
              modal.close();
              await run(macro);
            }}
          />
          <Button label="Cancel" onClick={() => modal.close()} />
        </Row>
      </>,
      { width: 420 }
    );
  }

  /* ------------------------------------------------------------ editor */
  interface Draft {
    name: string;
    text: string;
    confirm: boolean;
  }
  function Editor({ settings, close }: { settings: Settings; close(): void }): React.JSX.Element {
    const [drafts, setDrafts] = React.useState<Draft[]>(settings.macros.map((m) => ({ name: m.name, text: m.lines.join("\n"), confirm: m.confirm })));
    const [confirmAll, setConfirmAll] = React.useState(settings.confirmAll);
    const update = (i: number, patch: Partial<Draft>): void => setDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    const remove = (i: number): void => setDrafts((prev) => prev.filter((_, j) => j !== i));
    const move = (i: number, delta: number): void =>
      setDrafts((prev) => {
        const next = prev.slice();
        const j = i + delta;
        if (j < 0 || j >= next.length) return prev;
        [next[i], next[j]] = [next[j]!, next[i]!];
        return next;
      });
    const save = async (): Promise<void> => {
      const macros = drafts
        .map((d) => ({ name: d.name.trim(), lines: d.text.split("\n").map((l) => l.trim()).filter(Boolean), confirm: d.confirm }))
        .filter((m) => m.name && m.lines.length);
      const r = await window.usermod.setSettings("device-macros", { confirmAll, macros });
      if (!r.ok) throw new Error(r.message);
      rt.toast(`${macros.length} macro${macros.length === 1 ? "" : "s"} saved`, { kind: "success" });
      close();
    };
    return (
      <>
        <Sub>One command per line. Lines go to the machine exactly as written, so keep safe moves (G53 / G90) explicit.</Sub>
        <Toggle label="Confirm before running any macro" checked={confirmAll} onChange={setConfirmAll} />
        {drafts.map((d, i) => (
          <div key={i} className="usermod-section">
            <Input label={`Macro ${i + 1} name`} value={d.name} onChange={(name) => update(i, { name })} placeholder="Safe Z" />
            <label className="usermod-field">
              <span className="usermod-label">Commands</span>
              <textarea value={d.text} spellCheck={false} onChange={(e) => update(i, { text: e.target.value })} placeholder={"G53 G90 G0 Z-1\nG53 G90 G0 X-1 Y-1"} />
            </label>
            <Row>
              <Toggle label="Ask before sending" checked={d.confirm} onChange={(confirm) => update(i, { confirm })} />
              <Button label="↑" title="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
              <Button label="↓" title="Move down" disabled={i === drafts.length - 1} onClick={() => move(i, 1)} />
              <Button label="Remove" onClick={() => remove(i)} />
            </Row>
          </div>
        ))}
        <Row>
          <Button label="Add macro" onClick={() => setDrafts((prev) => [...prev, { name: "", text: "", confirm: true }])} />
          <Button label="Save" primary onClick={save} />
          <Button label="Cancel" onClick={close} />
        </Row>
      </>
    );
  }
  function openEditor(settings: Settings): void {
    const modal = ui.modal("Edit macros", { width: 520 });
    ui.react.mount(modal.body, <Editor settings={settings} close={modal.close} />);
  }

  /* ------------------------------------------------------------ popover */
  function Panel({ close }: { close(): void }): React.JSX.Element {
    const { data: info, error } = useInfo();
    if (error) return <Err>{error}</Err>;
    if (!info) return <Loading />;
    const settings = parseSettings(info.config.settings["device-macros"]);
    return (
      <>
        <h3>Macros</h3>
        {settings.macros.length ? (
          <Row>
            {settings.macros.map((m) => (
              <Button key={m.name} label={m.name} title={m.lines.join(" | ")} onClick={() => confirmThenRun(m, settings.confirmAll)} />
            ))}
          </Row>
        ) : (
          <Sub>No macros yet. Add some with Edit macros.</Sub>
        )}
        <Row>
          <Button
            label="Edit macros…"
            onClick={() => {
              close();
              openEditor(settings);
            }}
          />
        </Row>
      </>
    );
  }

  ui.toolbar.addButton({
    id: "device-macros",
    title: "Machine macros",
    icon: () => ui.icons.svg("M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"),
    order: 40,
    onClick: (button) => {
      let pop: Usermod.PopoverHandle | null = null;
      pop = ui.react.popover(button, <Panel close={() => pop?.close()} />, { width: 320 });
    }
  });
})();
