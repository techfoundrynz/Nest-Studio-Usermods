/*
 * Feeds & speeds: a calculator that starts from the tool library (diameter, flute count) and a material
 * preset (chip load per tooth, surface-speed range, depth and stepover rules) and gives feed, plunge feed,
 * depth of cut and stepover for a chosen spindle speed. Results are advisory starting points for a light
 * desktop machine; the operation's feed and speed still live in the CAM setup (the tool library stores
 * geometry only, so nothing is written back). Favourites are kept in mods.json for quick reference.
 *
 *   feed  = chip load × flutes × rpm          Vc = π × Ø × rpm / 1000 (m/min)
 *
 * mods.json settings ("feeds-speeds"): maxRpm (24000), favourites: [...]
 */
(function feedsSpeeds(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Section, Sub, Row, Button, Select, Input, KV, Err, Loading, useAsync, useInfo } = ui.react;
  rt.register({ name: "feeds-speeds", version: "0.1.0" });

  interface Material {
    id: string;
    label: string;
    /** Chip load per tooth (mm) for a 6 mm tool at [conservative, aggressive]; scaled by diameter. */
    chip: [number, number];
    /** Surface speed range m/min (carbide). */
    vc: [number, number];
    /** Depth of cut as a fraction of diameter for roughing, stepover fraction for roughing and finishing. */
    doc: number;
    stepover: [number, number];
    plungeFactor: number;
    note: string;
  }
  const MATERIALS: Material[] = [
    { id: "mdf", label: "MDF / particle board", chip: [0.1, 0.2], vc: [300, 900], doc: 1.0, stepover: [0.45, 0.1], plungeFactor: 0.5, note: "Dust extraction; compression or down-cut bits leave a clean face." },
    { id: "softwood", label: "Softwood (pine, cedar)", chip: [0.1, 0.2], vc: [300, 900], doc: 1.0, stepover: [0.45, 0.1], plungeFactor: 0.5, note: "Up-cut clears chips; tearout on the top edge with up-cut bits." },
    { id: "plywood", label: "Plywood / birch ply", chip: [0.08, 0.15], vc: [300, 800], doc: 0.75, stepover: [0.4, 0.1], plungeFactor: 0.45, note: "Compression bits avoid fuzz on both faces." },
    { id: "hardwood", label: "Hardwood (oak, maple, walnut)", chip: [0.06, 0.12], vc: [250, 700], doc: 0.5, stepover: [0.4, 0.08], plungeFactor: 0.4, note: "Reduce depth on interrupted cuts; watch for burning at low feed." },
    { id: "acrylic", label: "Acrylic (cast)", chip: [0.05, 0.1], vc: [150, 400], doc: 0.5, stepover: [0.35, 0.1], plungeFactor: 0.35, note: "Single-flute O bits; too slow a feed melts and welds chips." },
    { id: "hdpe", label: "HDPE / POM / nylon", chip: [0.1, 0.2], vc: [200, 500], doc: 0.75, stepover: [0.4, 0.1], plungeFactor: 0.4, note: "Sharp single or two flute; keep chips moving." },
    { id: "foam", label: "Rigid foam / modelling board", chip: [0.2, 0.4], vc: [400, 1200], doc: 2.0, stepover: [0.6, 0.15], plungeFactor: 0.7, note: "Feed is limited by the machine, not the material." },
    { id: "aluminium", label: "Aluminium (6061)", chip: [0.03, 0.06], vc: [120, 300], doc: 0.15, stepover: [0.2, 0.05], plungeFactor: 0.25, note: "Single-flute, air blast or mist; light desktop machines want shallow, fast passes." },
    { id: "brass", label: "Brass", chip: [0.03, 0.06], vc: [100, 250], doc: 0.15, stepover: [0.2, 0.05], plungeFactor: 0.25, note: "Zero-rake or single flute; chips are hot and sharp." }
  ];
  interface Favourite {
    tool: string;
    material: string;
    rpm: number;
    feed: number;
    plunge: number;
    doc: number;
    stepover: number;
    savedAt: number;
  }
  const isFav = (v: unknown): v is Favourite => typeof v === "object" && v !== null && typeof (v as Favourite).tool === "string" && typeof (v as Favourite).feed === "number";
  const round = (n: number, step = 1): number => Math.round(n / step) * step;

  function Calculator(): React.JSX.Element {
    const tools = useAsync(async () => {
      const r = await window.api.store.read();
      if (!r.ok) throw new Error(r.message ?? "store unreadable");
      return r.data.toolLibary?.cutLibrarySettings ?? [];
    }, []);
    const { data: info, refresh } = useInfo();
    const settings = info?.config.settings["feeds-speeds"] ?? {};
    const maxRpm = Number(settings.maxRpm) > 0 ? Number(settings.maxRpm) : 24000;
    const favourites: Favourite[] = Array.isArray(settings.favourites) ? settings.favourites.filter(isFav) : [];

    const [toolId, setToolId] = React.useState("");
    const [diameter, setDiameter] = React.useState("6");
    const [flutes, setFlutes] = React.useState("2");
    const [materialId, setMaterialId] = React.useState("plywood");
    const [rpm, setRpm] = React.useState("18000");
    const [aggr, setAggr] = React.useState("40");
    React.useEffect(() => {
      const t = tools.data?.find((x) => x.id === toolId);
      if (t) {
        setDiameter(String(t.diameter));
        setFlutes(String(Number(t.bladeCount) > 0 ? Number(t.bladeCount) : 2));
      }
    }, [toolId, tools.data]);
    if (tools.error) return <Err>{tools.error}</Err>;
    if (!tools.data) return <Loading />;

    const mat = MATERIALS.find((m) => m.id === materialId) ?? MATERIALS[0]!;
    const d = Math.max(0.5, Number(diameter) || 6);
    const z = Math.max(1, Math.round(Number(flutes) || 2));
    const n = Math.max(1000, Number(rpm) || 18000);
    const a = Math.min(100, Math.max(0, Number(aggr) || 0)) / 100;
    // Chip load scales with diameter (roughly linearly below 6 mm, gently above) so small bits do not snap.
    const scale = d < 6 ? d / 6 : Math.min(1.6, Math.sqrt(d / 6));
    const chip = (mat.chip[0] + (mat.chip[1] - mat.chip[0]) * a) * scale;
    const feed = chip * z * n;
    const plunge = feed * mat.plungeFactor;
    const vc = (Math.PI * d * n) / 1000;
    const doc = d * mat.doc * (0.6 + 0.4 * a);
    const stepRough = d * mat.stepover[0];
    const stepFinish = d * mat.stepover[1];
    const mrr = (feed * doc * stepRough) / 1000; // cm³/min
    const warnings: string[] = [];
    if (n > maxRpm) warnings.push(`Spindle speed above the machine maximum (${maxRpm} rpm).`);
    if (vc > mat.vc[1]) warnings.push(`Surface speed ${vc.toFixed(0)} m/min is above the range for ${mat.label} (${mat.vc[0]}–${mat.vc[1]}): lower the rpm.`);
    if (vc < mat.vc[0]) warnings.push(`Surface speed ${vc.toFixed(0)} m/min is below the range for ${mat.label}: raise the rpm or accept a slower feed.`);
    if (feed > 5000) warnings.push("Feed above 5000 mm/min: check the machine's maximum feed and acceleration.");
    if (d <= 2 && a > 0.5) warnings.push("Small bit at an aggressive chip load: consider the conservative end.");
    const toolLabel = tools.data.find((x) => x.id === toolId)?.name ?? `Ø${d} mm, ${z} flute`;

    const saveFavourite = async (): Promise<void> => {
      const fav: Favourite = { tool: toolLabel, material: mat.label, rpm: n, feed: round(feed, 10), plunge: round(plunge, 10), doc: round(doc, 0.1), stepover: round(stepRough, 0.1), savedAt: Date.now() };
      const r = await window.usermod.setSettings("feeds-speeds", { ...settings, favourites: [fav, ...favourites].slice(0, 30) });
      if (!r.ok) throw new Error(r.message);
      await refresh();
      rt.toast("Saved to favourites", { kind: "success" });
    };
    const removeFavourite = async (f: Favourite): Promise<void> => {
      const r = await window.usermod.setSettings("feeds-speeds", { ...settings, favourites: favourites.filter((x) => x !== f) });
      if (!r.ok) throw new Error(r.message);
      await refresh();
    };
    const summary = `${toolLabel} in ${mat.label}: ${n} rpm, feed ${round(feed, 10)} mm/min, plunge ${round(plunge, 10)} mm/min, DOC ${round(doc, 0.1)} mm, stepover ${round(stepRough, 0.1)} mm (finish ${round(stepFinish, 0.1)} mm), chip load ${chip.toFixed(3)} mm/tooth`;

    return (
      <>
        <div className="usermod-cyc-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0 14px" }}>
          <Select label="Tool from library" options={[{ value: "", label: "(manual)" }, ...tools.data.map((t) => ({ value: t.id, label: `T${t.slotNum} ${t.name}` }))]} value={toolId} onChange={setToolId} />
          <Input type="number" label="Diameter (mm)" value={diameter} onChange={setDiameter} step={0.1} />
          <Input type="number" label="Flutes" value={flutes} onChange={setFlutes} step={1} />
          <Select label="Material" options={MATERIALS.map((m) => ({ value: m.id, label: m.label }))} value={materialId} onChange={setMaterialId} help={mat.note} />
          <Input type="number" label="Spindle (rpm)" value={rpm} onChange={setRpm} step={500} help={`machine max ${maxRpm}`} />
          <Input type="number" label="Aggressiveness (0–100 %)" value={aggr} onChange={setAggr} step={5} help="0 = conservative chip load, 100 = aggressive" />
        </div>
        <Section title="Result">
          <KV
            pairs={[
              ["Chip load", `${chip.toFixed(3)} mm/tooth`],
              ["Feed", <strong>{`${round(feed, 10)} mm/min`}</strong>],
              ["Plunge feed", `${round(plunge, 10)} mm/min`],
              ["Depth of cut (roughing)", `${round(doc, 0.1)} mm`],
              ["Stepover", `${round(stepRough, 0.1)} mm roughing · ${round(stepFinish, 0.1)} mm finishing`],
              ["Surface speed", `${vc.toFixed(0)} m/min (${mat.label}: ${mat.vc[0]}–${mat.vc[1]})`],
              ["Material removal", `${mrr.toFixed(1)} cm³/min`]
            ]}
          />
          {warnings.length ? <Err>{warnings.map((w, i) => <div key={i}>{w}</div>)}</Err> : null}
          <Row>
            <Button
              label="Copy summary"
              onClick={async () => {
                await navigator.clipboard.writeText(summary);
                rt.toast("Copied", { kind: "success" });
              }}
            />
            <Button label="Save favourite" primary onClick={saveFavourite} />
          </Row>
        </Section>
        <Section title="Favourites">
          {favourites.length ? (
            favourites.map((f) => (
              <div key={f.savedAt} className="usermod-row" style={{ justifyContent: "space-between" }}>
                <span>
                  <strong>{f.tool}</strong> · {f.material} · <small className="usermod-sub">{`${f.rpm} rpm, F${f.feed} (plunge ${f.plunge}), DOC ${f.doc} mm, stepover ${f.stepover} mm`}</small>
                </span>
                <Button label="✕" title="Remove" onClick={() => removeFavourite(f)} />
              </div>
            ))
          ) : (
            <Sub>None saved yet.</Sub>
          )}
        </Section>
        <Sub>Starting points for a light desktop machine with carbide tooling. Listen to the cut: chatter means less depth or more feed, burning means more feed or less rpm. The tool library holds geometry only, so enter the values in the operation.</Sub>
      </>
    );
  }

  ui.toolbar.addButton({
    id: "feeds-speeds",
    title: "Feeds & speeds: chip-load calculator",
    icon: () => ui.icons.svg("M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v3h10V5H7zm0 6v2h2v-2H7zm4 0v2h2v-2h-2zm4 0v2h2v-2h-2zm-8 4v2h2v-2H7zm4 0v2h2v-2h-2zm4 0v2h2v-2h-2z"),
    order: 18,
    onClick: () => {
      ui.react.modal("Feeds & speeds", <Calculator />, { width: 760 });
    }
  });
})();
