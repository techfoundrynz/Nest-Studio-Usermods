/*
 * Tools: the machine's tool library and the numbers to run each cutter at.
 *
 * Library: export the tools you pick to JSON and import them back (or from another machine's store),
 * resolving id and slot clashes. Feeds & speeds: chip-load calculator per material against the same library.
 *
 * One toolbar icon opens a window with a tab per feature. Each feature keeps its own scope (a nested
 * function), so the code is the same as when they were separate mods; only the entry point is shared.
 * mods.json settings ("tools"): favourites (feeds & speeds), maxRpm
 */
(function tools(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "tools", version: "0.1.0" });

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
      const { Sub, Row, Button, Toggle, Select, KV, Err, Loading, useAsync } = ui.react;

      rt.addStyle(
        `.usermod-tl{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
         .usermod-tl th,.usermod-tl td{text-align:left;padding:4px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap}
         .usermod-tl th{font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.05em}
         .usermod-tl td.status{color:#777}.usermod-tl td.status.replace{color:#8a5a00}.usermod-tl td.status.new{color:#166534}
         html[data-theme=dark] .usermod-tl th,html[data-theme=dark] .usermod-tl td{border-color:#3a3a3a}`,
        "tool-library"
      );

      type Tool = NestStudio.Tool;
      const FORMAT = "neststudio-usermods-tools";
      interface ExportFile {
        format: string;
        version: number;
        exportedAt: string;
        appVersion?: string;
        tools: Tool[];
      }
      const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      const isTool = (v: unknown): v is Tool => isRecord(v) && typeof v.name === "string" && typeof v.type === "string" && typeof v.diameter === "number";
      /** Accepts this mod's file, a bare array, a store.json, or a toolLibary object. */
      function extractTools(parsed: unknown): Tool[] {
        if (Array.isArray(parsed)) return parsed.filter(isTool);
        if (!isRecord(parsed)) return [];
        if (Array.isArray(parsed.tools)) return parsed.tools.filter(isTool);
        if (Array.isArray(parsed.cutLibrarySettings)) return parsed.cutLibrarySettings.filter(isTool);
        const lib = parsed.toolLibary;
        if (isRecord(lib) && Array.isArray(lib.cutLibrarySettings)) return lib.cutLibrarySettings.filter(isTool);
        return [];
      }
      const TYPE_LABEL: Record<string, string> = { endmill: "Flat end mill", ball: "Ball nose", cone: "V / taper", drill: "Drill", chamfer: "Chamfer", thread: "Thread mill", engrave: "Engraver" };
      const typeLabel = (t: Tool): string => TYPE_LABEL[t.type] ?? t.type;
      const flutes = (t: Tool): string => (typeof t.bladeCount === "number" ? `${t.bladeCount}` : "—");

      async function readLibrary(): Promise<{ store: NestStudio.Store; tools: Tool[] }> {
        const r = await window.api.store.read();
        if (!r.ok) throw new Error(r.message ?? "could not read the store");
        return { store: r.data, tools: r.data.toolLibary?.cutLibrarySettings ?? [] };
      }

      /* ---------------------------------------------------------------- export */
      function ExportView({ tools }: { tools: Tool[] }): React.JSX.Element {
        const [picked, setPicked] = React.useState(() => new Set(tools.map((t) => t.id)));
        const set = (id: string, on: boolean): void =>
          setPicked((prev) => {
            const next = new Set(prev);
            if (on) next.add(id);
            else next.delete(id);
            return next;
          });
        const exportPicked = async (): Promise<void> => {
          const chosen = tools.filter((t) => picked.has(t.id));
          if (!chosen.length) throw new Error("Nothing selected");
          const dialog = await window.api.dialog.showSave({ defaultPath: `tool-library-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
          if (!dialog.ok || !dialog.data.filePath || dialog.data.canceled) return;
          const file: ExportFile = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), tools: chosen };
          const w = await window.api.store.writeFile(dialog.data.filePath, JSON.stringify(file, null, 2));
          if (!w.ok) throw new Error(w.message ?? w.code ?? "write failed");
          rt.toast(`Exported ${chosen.length} tool(s) to ${dialog.data.filePath}`, { kind: "success", duration: 5000 });
        };
        return (
          <>
            <Row>
              <Button label="All" onClick={() => setPicked(new Set(tools.map((t) => t.id)))} />
              <Button label="None" onClick={() => setPicked(new Set())} />
              <Button label={`Export ${picked.size} selected…`} primary disabled={!picked.size} onClick={exportPicked} />
            </Row>
            {tools.length ? (
              <table className="usermod-tl">
                <thead>
                  <tr>
                    <th />
                    <th>Slot</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Ø</th>
                    <th>Flutes</th>
                    <th>Shank</th>
                    <th>Flute length</th>
                  </tr>
                </thead>
                <tbody>
                  {tools
                    .slice()
                    .sort((a, b) => Number(a.slotNum) - Number(b.slotNum))
                    .map((t) => (
                      <tr key={t.id}>
                        <td>
                          <input type="checkbox" checked={picked.has(t.id)} onChange={(e) => set(t.id, e.target.checked)} />
                        </td>
                        <td>T{t.slotNum}</td>
                        <td><strong>{t.name}</strong></td>
                        <td>{typeLabel(t)}</td>
                        <td>{t.diameter} mm</td>
                        <td>{flutes(t)}</td>
                        <td>{typeof t.toolShankDiameter === "number" ? `Ø${t.toolShankDiameter}` : "—"}</td>
                        <td>{typeof t.bladeLength === "number" ? `${t.bladeLength} mm` : "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <Sub>The tool library is empty.</Sub>
            )}
          </>
        );
      }

      /* ---------------------------------------------------------------- import */
      type IdPolicy = "replace" | "keep-both" | "skip";
      type SlotPolicy = "next-free" | "keep";
      interface Plan {
        tool: Tool;
        status: "new" | "replace" | "duplicate" | "skip";
        slot: number;
        note: string;
      }
      function plan(incoming: Tool[], existing: Tool[], idPolicy: IdPolicy, slotPolicy: SlotPolicy): Plan[] {
        const byId = new Map(existing.map((t) => [t.id, t]));
        const usedSlots = new Set(existing.map((t) => Number(t.slotNum)).filter((n) => Number.isFinite(n) && n > 0));
        let nextFree = 1;
        const takeFree = (): number => {
          while (usedSlots.has(nextFree)) nextFree += 1;
          usedSlots.add(nextFree);
          return nextFree;
        };
        const out: Plan[] = [];
        for (const raw of incoming) {
          const tool: Tool = { ...raw, id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(), slotNum: Number(raw.slotNum) };
          const clash = byId.get(tool.id);
          let status: Plan["status"] = "new";
          let note = "";
          if (clash) {
            if (idPolicy === "skip") {
              out.push({ tool, status: "skip", slot: Number(clash.slotNum), note: `same id as "${clash.name}" (T${clash.slotNum})` });
              continue;
            }
            if (idPolicy === "replace") {
              status = "replace";
              note = `replaces "${clash.name}" (T${clash.slotNum})`;
              usedSlots.delete(Number(clash.slotNum));
            } else {
              tool.id = crypto.randomUUID();
              status = "duplicate";
              note = `kept alongside "${clash.name}" with a new id`;
            }
          }
          let slot = Number.isFinite(tool.slotNum) && tool.slotNum > 0 ? tool.slotNum : 0;
          if (!slot || (usedSlots.has(slot) && slotPolicy === "next-free")) {
            const moved = takeFree();
            if (slot && moved !== slot) note += `${note ? "; " : ""}slot T${slot} taken → T${moved}`;
            slot = moved;
          } else if (usedSlots.has(slot)) note += `${note ? "; " : ""}shares slot T${slot}`;
          else usedSlots.add(slot);
          out.push({ tool: { ...tool, slotNum: slot }, status, slot, note });
        }
        return out;
      }
      function ImportView({ incoming, existing, fileName, done }: { incoming: Tool[]; existing: Tool[]; fileName: string; done(): void }): React.JSX.Element {
        const [idPolicy, setIdPolicy] = React.useState<IdPolicy>("replace");
        const [slotPolicy, setSlotPolicy] = React.useState<SlotPolicy>("next-free");
        const [picked, setPicked] = React.useState(() => new Set(incoming.map((_, i) => i)));
        const plans = plan(incoming, existing, idPolicy, slotPolicy);
        const chosen = plans.filter((p, i) => picked.has(i) && p.status !== "skip");
        const set = (i: number, on: boolean): void =>
          setPicked((prev) => {
            const next = new Set(prev);
            if (on) next.add(i);
            else next.delete(i);
            return next;
          });
        const apply = async (): Promise<void> => {
          if (!chosen.length) throw new Error("Nothing selected");
          const { store, tools } = await readLibrary(); // fresh copy right before writing
          const replaced = new Set(chosen.filter((p) => p.status === "replace").map((p) => p.tool.id));
          const nextTools = [...tools.filter((t) => !replaced.has(t.id)), ...chosen.map((p) => p.tool)];
          const w = await window.api.store.write({ ...store, toolLibary: { ...(store.toolLibary ?? {}), cutLibrarySettings: nextTools } });
          if (!w.ok) throw new Error(w.message ?? w.code ?? "store write failed");
          rt.toast(`Imported ${chosen.length} tool(s); reloading the UI so the library shows them`, { kind: "success", duration: 4000 });
          done();
          setTimeout(() => window.location.reload(), 900);
        };
        return (
          <>
            <Sub>{`${incoming.length} tool(s) found in ${fileName}. The library has ${existing.length}.`}</Sub>
            <Row>
              <Select label="Same id already in the library" options={[{ value: "replace", label: "Replace the existing tool" }, { value: "keep-both", label: "Keep both (new id)" }, { value: "skip", label: "Skip" }]} value={idPolicy} onChange={(v) => setIdPolicy(v === "keep-both" ? "keep-both" : v === "skip" ? "skip" : "replace")} />
              <Select label="Slot already taken" options={[{ value: "next-free", label: "Move to the next free slot" }, { value: "keep", label: "Keep the slot (shared)" }]} value={slotPolicy} onChange={(v) => setSlotPolicy(v === "keep" ? "keep" : "next-free")} />
            </Row>
            <table className="usermod-tl">
              <thead>
                <tr>
                  <th />
                  <th>Slot</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Ø</th>
                  <th>Flutes</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <input type="checkbox" checked={picked.has(i) && p.status !== "skip"} disabled={p.status === "skip"} onChange={(e) => set(i, e.target.checked)} />
                    </td>
                    <td>T{p.slot}</td>
                    <td><strong>{p.tool.name}</strong></td>
                    <td>{typeLabel(p.tool)}</td>
                    <td>{p.tool.diameter} mm</td>
                    <td>{flutes(p.tool)}</td>
                    <td className={`status ${p.status}`}>{p.status === "new" ? "new" : p.status}{p.note ? ` — ${p.note}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Row>
              <Button label={`Import ${chosen.length} tool(s)`} primary disabled={!chosen.length} onClick={apply} />
              <Button label="Cancel" onClick={done} />
            </Row>
          </>
        );
      }

      /* ------------------------------------------------------------------ root */
      function Root({ close }: { close(): void }): React.JSX.Element {
        const lib = useAsync(readLibrary, []);
        const [incoming, setIncoming] = React.useState<{ tools: Tool[]; fileName: string } | null>(null);
        const [showExport, setShowExport] = React.useState(false);
        const pickFile = async (): Promise<void> => {
          const dialog = await window.api.dialog.showOpen({ filters: [{ name: "JSON", extensions: ["json"] }], properties: ["openFile"] });
          const file = dialog.ok ? dialog.data.filePaths?.[0] : undefined;
          if (!file || (dialog.ok && dialog.data.canceled)) return;
          const r = await window.api.store.readFile(file);
          if (!r.ok) throw new Error(r.message ?? r.code ?? "could not read the file");
          let parsed: unknown;
          try {
            parsed = JSON.parse(r.data);
          } catch {
            throw new Error("Not a JSON file");
          }
          const tools = extractTools(parsed);
          if (!tools.length) throw new Error("No tools found in that file (expected this mod's export, a tool array, or a store.json)");
          setIncoming({ tools, fileName: file.split(/[\\/]/).pop() ?? file });
        };
        if (lib.error) return <Err>{lib.error}</Err>;
        if (!lib.data) return <Loading />;
        if (incoming) return <ImportView incoming={incoming.tools} existing={lib.data.tools} fileName={incoming.fileName} done={() => setIncoming(null)} />;
        return (
          <>
            <KV pairs={[["Tools in library", String(lib.data.tools.length)], ["Slots in use", lib.data.tools.slice().sort((a, b) => Number(a.slotNum) - Number(b.slotNum)).map((t) => `T${t.slotNum} ${t.name}`).join(" · ") || "—"]]} />
            <Row>
              <Button label={showExport ? "Hide export list" : "Export tools…"} primary onClick={() => setShowExport((v) => !v)} />
              <Button label="Import from JSON…" onClick={pickFile} />
              <Button label="Close" onClick={close} />
            </Row>
            {showExport ? <ExportView tools={lib.data.tools} /> : null}
            <Sub>Export writes a JSON file you can share or back up; import reads that file (or another machine's store.json) and lets you pick tools and resolve id and slot clashes.</Sub>
          </>
        );
      }
    tabs.push({ id: "library", label: "Tool library", open: (body, close) => ui.react.mount(body, <Root close={close} />) });
  })();

  (function feature(): void {
      const rt = window.usermodRuntime;
      const ui = window.usermodUI;
      const { Section, Sub, Row, Button, Select, Input, KV, Err, Loading, useAsync, useInfo } = ui.react;

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
    tabs.push({ id: "feeds", label: "Feeds & speeds", open: (body) => ui.react.mount(body, <Calculator />) });
  })();


  rt.addStyle(
    `.usermod-tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
     .usermod-tabs .usermod-btn[data-active=true]{background:#0f766e;color:#fff}`,
    "tools-tabs"
  );
  function openWindow(startTab = tabs[0]?.id): void {
    const modal = ui.modal("Tools", { width: 760 });
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
    id: "tools",
    title: "Tools: library and feeds & speeds",
    icon: () => ui.icons.svg("M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"),
    order: 36,
    onClick: () => openWindow()
  });
  window.usermodTools = { open: openWindow };
})();
