/*
 * Bed size: Nest Studio hard-codes one machine envelope in its renderer, X 238 mm, Y 200 mm, Z 123 mm of
 * travel, plus a 225 mm work platform in the 3D view. On a machine with a different bed that makes the app
 * refuse programs that would fit, clamp continuous jog too early, and draw the wrong platform. This mod
 * stores the real travel in mods.json; the loader hands it to the renderer through the preload before the
 * app's own code runs, and the installer's --bed-size build option makes the app read it.
 *
 * What it changes: the "program exceeds the machine limits" checks (both the export/send check and the Device
 * tab's travel check), how far a continuous jog may travel, and the size of the 3D work platform and grid.
 * What it cannot change: the machine's own soft limits. The firmware still stops where it stops, so measure
 * the real travel rather than guessing upwards.
 *
 * mods.json settings ("bed-size"): enabled (true), travelX (238), travelY (200), travelZ (123), platform (225)
 */
(function bedSize(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, KV, Toggle, Input, Err, Section } = ui.react;
  rt.register({ name: "bed-size", version: "0.1.0" });

  /** The app's own constants, for comparison in the UI. */
  const APP = { travelX: 238, travelY: 200, travelZ: 123, platform: 225 };
  interface Settings {
    enabled: boolean;
    travelX: number;
    travelY: number;
    travelZ: number;
    platform: number;
  }
  const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  function parse(raw: Record<string, unknown> | undefined): Settings {
    return {
      enabled: raw?.enabled !== false,
      travelX: num(raw?.travelX, APP.travelX),
      travelY: num(raw?.travelY, APP.travelY),
      travelZ: num(raw?.travelZ, APP.travelZ),
      platform: num(raw?.platform, APP.platform)
    };
  }
  /** What the renderer is using right now (set by the preload; absent when the build option is off). */
  const live = (): { x: number; y: number; z: number } | null => {
    const bed = globalThis.__usermodBed;
    return bed ? { x: -bed.X.min, y: -bed.Y.min, z: -bed.Z.min } : null;
  };
  const patched = (): boolean => globalThis.__usermodBed !== undefined;

  function Panel({ close }: { close(): void }): React.JSX.Element {
    const [saved, setSaved] = React.useState<Settings | null>(null);
    const [draft, setDraft] = React.useState<Settings | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
      void window.usermod.info().then((r) => {
        if (!r.ok) {
          setError(r.message);
          return;
        }
        const s = parse(r.data.config.settings["bed-size"]);
        setSaved(s);
        setDraft(s);
      });
    }, []);
    if (error) return <Err>{error}</Err>;
    if (!saved || !draft) return <Sub>Loading…</Sub>;
    const current = live();
    const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
    const set = (key: keyof Settings, value: number | boolean): void => setDraft({ ...draft, [key]: value });
    const field = (key: "travelX" | "travelY" | "travelZ" | "platform", label: string, help: string): React.ReactNode => (
      <Input
        type="number"
        label={label}
        value={String(draft[key])}
        min={1}
        max={5000}
        step={1}
        help={help}
        disabled={!draft.enabled}
        onChange={(v) => {
          const n = Number(v);
          if (Number.isFinite(n)) set(key, n);
        }}
      />
    );
    const save = async (): Promise<void> => {
      const r = await window.usermod.setSettings("bed-size", { ...draft });
      if (!r.ok) throw new Error(r.message);
      setSaved(draft);
      rt.toast("Bed size saved. Reloading the UI so the app picks it up…", { kind: "success" });
      close();
      setTimeout(() => window.location.reload(), 700);
    };
    return (
      <>
        <h3>Bed size</h3>
        {!patched() ? <Err>This build does not carry the bed-size option. Re-run the installer and answer yes to &quot;Bed size override&quot; (or pass --bed-size).</Err> : null}
        <KV
          pairs={[
            ["App's built-in envelope", `X ${APP.travelX} · Y ${APP.travelY} · Z ${APP.travelZ} mm`],
            ["In use now", current ? `X ${current.x} · Y ${current.y} · Z ${current.z} mm` : "the app's own numbers"],
            ["Work platform", `${draft.platform} mm${draft.platform === APP.platform ? " (app default)" : ""}`]
          ]}
        />
        <Toggle label="Override the machine envelope" checked={draft.enabled} onChange={(on) => set("enabled", on)} help="Off leaves the app's built-in numbers alone." />
        <Section title="Travel per axis (mm)">
          {field("travelX", "X travel", "Measured from the home corner; the app works in negative machine coordinates.")}
          {field("travelY", "Y travel", "")}
          {field("travelZ", "Z travel", "")}
        </Section>
        <Section title="3D view">
          {field("platform", "Work platform size", "The grid the stock sits on in the 3D views. Applies after the reload.")}
        </Section>
        <Sub>
          This only changes what the app believes. The machine still enforces its own soft limits, so measure the real travel before raising these; a program that fits the app's check can still hit an end stop.
        </Sub>
        <Row>
          <Button label="Save and reload the UI" primary disabled={!dirty} onClick={save} />
          <Button label="Reset to the app's values" disabled={draft.travelX === APP.travelX && draft.travelY === APP.travelY && draft.travelZ === APP.travelZ && draft.platform === APP.platform} onClick={() => setDraft({ ...draft, ...APP })} />
          <Button label="Close" onClick={close} />
        </Row>
      </>
    );
  }

  ui.toolbar.addButton({
    id: "bed-size",
    title: "Bed size",
    icon: () => ui.icons.svg("M3 5h18v14H3V5zm2 2v10h14V7H5zm1 1h5v2H6V8zm0 3h5v2H6v-2zm7-3h5v5h-5V8z"),
    order: 24,
    onClick: (button) => {
      let pop: Usermod.PopoverHandle | null = null;
      pop = ui.react.popover(button, <Panel close={() => pop?.close()} />, { width: 420 });
    }
  });
})();
