/*
 * Tool library import / export: the app keeps its tools in the user store (toolLibary.cutLibrarySettings). This
 * mod adds "Tool library…" to the MODS menu: tick the tools to export to a JSON file, or open a JSON file
 * (this mod's format, a bare array of tools, or a whole store / toolLibary object), tick what to import, and
 * choose how to treat clashes: same id → replace or keep both; same slot → move to the next free slot or keep.
 * The store is written back through the app's own bridge and the UI reloads so the library picks it up.
 */
(function toolLibrary(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, Toggle, Select, KV, Err, Loading, useAsync } = ui.react;
  rt.register({ name: "tool-library", version: "0.1.0" });

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

  ui.toolbar.addButton({
    id: "tool-library",
    title: "Tool library: export / import tools as JSON",
    icon: () => ui.icons.svg("M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"),
    order: 37,
    onClick: () => {
      let modal: Usermod.ModalHandle | null = null;
      modal = ui.react.modal("Tool library", <Root close={() => modal?.close()} />, { width: 720 });
    }
  });
})();
