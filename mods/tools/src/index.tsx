/*
 * Tool library: export the tools you pick to a JSON file and import them back, from this mod's own format, a
 * bare array of tools, another machine's store.json, or a Fusion 360 library (its `.json` libraries and its
 * `.tools` exports, which are zipped). The import lists every incoming tool with what will
 * happen to it and how clashes resolve: same id replaces, keeps both with a new id, or is skipped; a taken
 * slot moves to the next free one or is shared.
 *
 * The app keeps its tools in the user store (toolLibary.cutLibrarySettings); this writes them back through
 * the app's own bridge and reloads the UI so the library picks them up.
 */
(function toolLibrary(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "tools", version: "0.3.0" });

        const { Sub, Row, Button, Toggle, Select, KV, Err, Loading, useAsync, ModalFooter } = ui.react;

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
    interface Extracted {
      tools: Tool[];
      /** Fusion type phrases that have no equivalent here, so the reader can say what was left behind. */
      unsupported: string[];
      source: string;
    }
    /** Accepts this mod's file, a bare array, a store.json, a toolLibary object, or a Fusion 360 library. */
    function extractTools(parsed: unknown): Extracted {
      const own = (tools: Tool[], source: string): Extracted => ({ tools, unsupported: [], source });
      if (isFusionLibrary(parsed)) {
        const { tools, unsupported } = fromFusion(parsed);
        return { tools, unsupported, source: "Fusion 360" };
      }
      if (Array.isArray(parsed)) return own(parsed.filter(isTool), "tool array");
      if (!isRecord(parsed)) return own([], "unknown");
      if (Array.isArray(parsed.tools)) return own(parsed.tools.filter(isTool), "tool library export");
      if (Array.isArray(parsed.cutLibrarySettings)) return own(parsed.cutLibrarySettings.filter(isTool), "store.json");
      const lib = parsed.toolLibary;
      if (isRecord(lib) && Array.isArray(lib.cutLibrarySettings)) return own(lib.cutLibrarySettings.filter(isTool), "store.json");
      return own([], "unknown");
    }


    /* ------------------------------------------------------------ .tools zip */
    /*
     * Fusion writes an exported library as `<name>.tools`, which is a zip holding a single `tools.json`, so
     * reading one means unzipping it first. Rather than carry a zip library, this reads the archive's central
     * directory (the authoritative place for names, sizes and offsets: a local header may leave the sizes at
     * zero and put them in a trailing data descriptor) and inflates the entry with the browser's own
     * DecompressionStream. Only the two methods a Fusion export actually uses are handled: stored and deflate.
     */
    /** Bytes backed by a real ArrayBuffer, which is what DataView and Blob want. */
    type Bytes = Uint8Array<ArrayBuffer>;
    const ZIP_EOCD = 0x06054b50;
    const ZIP_CENTRAL = 0x02014b50;
    const isZip = (bytes: Bytes): boolean => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    interface ZipEntry {
      name: string;
      method: number;
      offset: number;
      compressedSize: number;
    }
    /** Walks back from the end for the end-of-central-directory record, then reads every entry header. */
    function zipEntries(bytes: Bytes): ZipEntry[] {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let eocd = -1;
      for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i -= 1) {
        if (view.getUint32(i, true) === ZIP_EOCD) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new Error("not a readable zip: no end-of-central-directory record");
      const count = view.getUint16(eocd + 10, true);
      let p = view.getUint32(eocd + 16, true);
      const out: ZipEntry[] = [];
      const text = new TextDecoder();
      for (let i = 0; i < count; i += 1) {
        if (p + 46 > bytes.length || view.getUint32(p, true) !== ZIP_CENTRAL) break;
        const method = view.getUint16(p + 10, true);
        const compressedSize = view.getUint32(p + 20, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const offset = view.getUint32(p + 42, true);
        out.push({ name: text.decode(bytes.subarray(p + 46, p + 46 + nameLen)), method, offset, compressedSize });
        p += 46 + nameLen + extraLen + commentLen;
      }
      return out;
    }
    async function zipRead(bytes: Bytes, entry: ZipEntry): Promise<string> {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // The local header repeats the name and extra lengths, and only it knows where the payload starts.
      const nameLen = view.getUint16(entry.offset + 26, true);
      const extraLen = view.getUint16(entry.offset + 28, true);
      const start = entry.offset + 30 + nameLen + extraLen;
      const body = bytes.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return new TextDecoder().decode(body);
      if (entry.method !== 8) throw new Error(`unsupported zip compression (method ${entry.method})`);
      const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new TextDecoder().decode(await new Response(stream).arrayBuffer());
    }
    /** The JSON inside a `.tools` export: `tools.json` by name, else the only JSON entry in the archive. */
    async function readToolsArchive(bytes: Bytes): Promise<string> {
      const entries = zipEntries(bytes);
      const named = entries.find((e) => e.name.toLowerCase() === "tools.json");
      const json = named ?? entries.find((e) => e.name.toLowerCase().endsWith(".json"));
      if (!json) throw new Error(`no tools.json inside the archive (found ${entries.map((e) => e.name).join(", ") || "nothing"})`);
      return zipRead(bytes, json);
    }

    /* ------------------------------------------------------- Fusion 360 import */
    /*
     * Fusion 360 (and HSMWorks) tool libraries are JSON: { data: [ tool, ... ] }, one entry per tool with a
     * `type` phrase, a `geometry` block of ISO 13399-style codes and a `post-process.number` holding the tool
     * number. Only the fields the app actually stores are carried across; Fusion's holder, presets (feeds and
     * speeds), grade and product links have nowhere to go and are dropped.
     *
     *   DC diameter · NOF flutes · LCF flute length · SFDM shank Ø · OAL overall length
     *   shoulder-diameter / shoulder-length · TA taper or chamfer angle · SIG drill point angle · TP thread pitch
     *
     * Angles are already degrees. Lengths follow the tool's own `unit`, so an inch library is converted.
     *
     * Two Fusion fields deliberately go nowhere. A bull nose cutter's corner radius (RE) has no home here,
     * because this app describes that shape by tool type alone. And a thread mill's pitch is taken from TP
     * only: TPN and TPX are the range of pitches the cutter can produce, not the one it is set to, so a mill
     * without a TP is left with no pitch and the thread operation supplies it instead.
     */
    interface FusionGeometry {
      DC?: number;
      NOF?: number;
      LCF?: number;
      LB?: number;
      OAL?: number;
      SFDM?: number;
      RE?: number;
      TA?: number;
      SIG?: number;
      TP?: number;
      "shoulder-diameter"?: number;
      "shoulder-length"?: number;
    }
    interface FusionTool {
      guid?: string;
      type?: string;
      unit?: string;
      description?: string;
      vendor?: string;
      BMC?: string;
      "product-id"?: string;
      geometry?: FusionGeometry;
      "post-process"?: { number?: number };
    }
    /** Fusion's type phrases mapped onto the app's own vocabulary; anything absent here cannot be imported. */
    const FUSION_TYPES: Record<string, string> = {
      "flat end mill": "endmill",
      "square end mill": "endmill",
      "end mill": "endmill",
      "face mill": "endmill",
      "ball end mill": "ball",
      "bull nose end mill": "bullnose",
      "radius mill": "round_chamfer",
      "chamfer mill": "chamfer",
      "counter sink": "chamfer",
      "countersink": "chamfer",
      "tapered mill": "cone",
      "taper mill": "cone",
      "drill": "drill",
      "spot drill": "drill",
      "center drill": "drill",
      "centre drill": "drill",
      "reamer": "drill",
      "thread mill": "thread",
      "tap right hand": "thread",
      "tap left hand": "thread",
      "slot mill": "t_slot",
      "t-slot mill": "t_slot"
    };
    const isFusionLibrary = (v: unknown): boolean => {
      if (!isRecord(v) || !Array.isArray(v.data)) return false;
      return v.data.some((entry) => isRecord(entry) && (typeof entry.guid === "string" || isRecord(entry.geometry)));
    };
    const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
    /** Fusion tools carry their own unit, so a mixed library still converts correctly. */
    function fusionToTool(raw: FusionTool, index: number): Tool | null {
      const kind = FUSION_TYPES[(raw.type ?? "").trim().toLowerCase()];
      if (!kind) return null;
      const g = raw.geometry ?? {};
      const scale = (raw.unit ?? "").toLowerCase().startsWith("inch") ? 25.4 : 1;
      const len = (value: number | undefined): number | undefined => (typeof value === "number" && Number.isFinite(value) ? round4(value * scale) : undefined);
      const diameter = len(g.DC);
      if (diameter === undefined || diameter <= 0) return null;
      const shank = len(g.SFDM) ?? diameter;
      const flute = len(g.LCF) ?? 0;
      const material = (raw.BMC ?? "").trim();
      const name = (raw.description ?? "").trim() || (raw["product-id"] ?? "").trim() || `${raw.type ?? "Tool"} ${diameter}mm`;
      const tool: Tool = {
        id: typeof raw.guid === "string" && raw.guid ? raw.guid : crypto.randomUUID(),
        name,
        type: kind,
        diameter,
        /* Fusion's tool number, offered as a slot only if the reader asks for it; the default leaves it unloaded. */
        slotNum: typeof raw["post-process"]?.number === "number" ? raw["post-process"].number : index + 1,
        bladeCount: typeof g.NOF === "number" && g.NOF > 0 ? g.NOF : 2,
        bladeLength: flute,
        toolShankDiameter: shank,
        toolShoulderDiameter: len(g["shoulder-diameter"]) ?? shank,
        shoulderLength: len(g["shoulder-length"]) ?? len(g.LB) ?? flute,
        totalLength: len(g.OAL) ?? 0,
        toolMaterial: material,
        coating: material.toLowerCase().includes("coated"),
        durability: 100,
        isRead: false
      };
      /* The app reads `angle` for tapered and chamfer cutters and for the drill point, and `pitch` for thread
       * mills (see its own bit-to-CAM mapping); everything else leaves them at zero. */
      const angle = kind === "drill" ? g.SIG : g.TA;
      if (typeof angle === "number" && angle > 0) tool.angle = round4(angle);
      const pitch = len(g.TP); // TP only; see the note above on TPN / TPX
      if (kind === "thread" && pitch !== undefined && pitch > 0) tool.pitch = pitch;
      return tool;
    }
    function fromFusion(parsed: unknown): { tools: Tool[]; unsupported: string[] } {
      const rows: unknown[] = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
      const tools: Tool[] = [];
      const unsupported: string[] = [];
      rows.forEach((row, i) => {
        if (!isRecord(row)) return;
        const converted = fusionToTool(row as FusionTool, i);
        if (converted) tools.push(converted);
        else {
          const label = typeof row.type === "string" && row.type ? row.type : "unknown type";
          if (!unsupported.includes(label)) unsupported.push(label);
        }
      });
      return { tools, unsupported };
    }

    /** The app's own tool vocabulary, in its own words. */
    const TYPE_LABEL: Record<string, string> = { endmill: "Flat end mill", bullnose: "Ball nose", ball: "Ball end mill", round_chamfer: "Radius chamfer", chamfer: "Chamfer mill", cone: "Tapered", t_slot: "T-slot", drill: "Drill", thread: "Thread mill" };
    const typeLabel = (t: Tool): string => TYPE_LABEL[t.type] ?? t.type;
    const flutes = (t: Tool): string => (typeof t.bladeCount === "number" ? `${t.bladeCount}` : "—");
    /** Magazine slot for display: a dash when the tool is in the library but not loaded on the machine. */
    const slotLabel = (slot: number | null | undefined): string => (typeof slot === "number" && slot > 0 ? `T${slot}` : "not loaded");

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
                      <td>{slotLabel(t.slotNum)}</td>
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
    /*
     * A magazine slot is a physical pocket on the machine, not a tool number. The app only offers tools whose
     * slot is null when you load a magazine slot, so an imported tool that arrives holding a number looks like
     * it is already loaded and never appears in that picker. "unloaded" is therefore the honest default for a
     * Fusion library, whose numbers are just tool numbers from someone else's post.
     */
    type SlotPolicy = "unloaded" | "next-free" | "keep";
    interface Plan {
      tool: Tool;
      status: "new" | "replace" | "duplicate" | "skip";
      /** null means "in the library but not loaded into the magazine". */
      slot: number | null;
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
        const wanted = Number.isFinite(Number(raw.slotNum)) && Number(raw.slotNum) > 0 ? Number(raw.slotNum) : null;
        const tool: Tool = { ...raw, id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(), slotNum: wanted };
        const clash = byId.get(tool.id);
        let status: Plan["status"] = "new";
        let note = "";
        if (clash) {
          if (idPolicy === "skip") {
            out.push({ tool, status: "skip", slot: clash.slotNum ?? null, note: `same id as "${clash.name}"` });
            continue;
          }
          if (idPolicy === "replace") {
            status = "replace";
            note = `replaces "${clash.name}"`;
            if (clash.slotNum != null) usedSlots.delete(Number(clash.slotNum));
          } else {
            tool.id = crypto.randomUUID();
            status = "duplicate";
            note = `kept alongside "${clash.name}" with a new id`;
          }
        }
        /* A tool that names no slot stays unloaded rather than being given one it never had. */
        let slot: number | null = wanted;
        if (slotPolicy === "unloaded" || slot === null) {
          slot = null;
        } else if (usedSlots.has(slot) && slotPolicy === "next-free") {
          const moved = takeFree();
          if (moved !== slot) note += `${note ? "; " : ""}slot T${slot} taken → T${moved}`;
          slot = moved;
        } else if (usedSlots.has(slot)) {
          note += `${note ? "; " : ""}shares slot T${slot}`;
        } else {
          usedSlots.add(slot);
        }
        out.push({ tool: { ...tool, slotNum: slot }, status, slot, note });
      }
      return out;
    }
    function ImportView({ incoming, existing, fileName, source, unsupported, done }: { incoming: Tool[]; existing: Tool[]; fileName: string; source: string; unsupported: string[]; done(): void }): React.JSX.Element {
      const [idPolicy, setIdPolicy] = React.useState<IdPolicy>("replace");
      const [slotPolicy, setSlotPolicy] = React.useState<SlotPolicy>(source === "Fusion 360" ? "unloaded" : "next-free");
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
          <Sub>{`${incoming.length} tool(s) read from ${fileName} as a ${source} library. The library here has ${existing.length}.`}</Sub>
          {unsupported.length ? (
            <Sub>{`Skipped, because this app has no such tool: ${unsupported.join(", ")}. Feeds, speeds and holders are not imported.`}</Sub>
          ) : null}
          <Row>
            <Select label="Same id already in the library" options={[{ value: "replace", label: "Replace the existing tool" }, { value: "keep-both", label: "Keep both (new id)" }, { value: "skip", label: "Skip" }]} value={idPolicy} onChange={(v) => setIdPolicy(v === "keep-both" ? "keep-both" : v === "skip" ? "skip" : "replace")} />
            <Select
              label="Magazine slot"
              options={[
                { value: "unloaded", label: "Leave unloaded (load them on the machine)" },
                { value: "next-free", label: "Claim a slot, moving off taken ones" },
                { value: "keep", label: "Claim the slot it names (shared)" }
              ]}
              value={slotPolicy}
              onChange={(v) => setSlotPolicy(v === "keep" ? "keep" : v === "next-free" ? "next-free" : "unloaded")}
            />
          </Row>
          <Sub>
            A magazine slot is a physical pocket on the machine, and it only offers unloaded tools when you load
            one. Tools imported as unloaded show up in the library and can then be loaded on the device.
          </Sub>
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
                  <td>{slotLabel(p.slot)}</td>
                  <td><strong>{p.tool.name}</strong></td>
                  <td>{typeLabel(p.tool)}</td>
                  <td>{p.tool.diameter} mm</td>
                  <td>{flutes(p.tool)}</td>
                  <td className={`status ${p.status}`}>{p.status === "new" ? "new" : p.status}{p.note ? ` — ${p.note}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ModalFooter>
            <Sub>{`${chosen.length} of ${incoming.length} selected`}</Sub>
            <Button label={`Import ${chosen.length} tool(s)`} primary disabled={!chosen.length} onClick={apply} />
            <Button label="Cancel" onClick={done} />
          </ModalFooter>
        </>
      );
    }

    /* ------------------------------------------------------------------ root */
    function Root({ close }: { close(): void }): React.JSX.Element {
      const lib = useAsync(readLibrary, []);
      const [incoming, setIncoming] = React.useState<{ tools: Tool[]; unsupported: string[]; source: string; fileName: string } | null>(null);
      const [showExport, setShowExport] = React.useState(false);
      const pickFile = async (): Promise<void> => {
        const dialog = await window.api.dialog.showOpen({
          filters: [
            { name: "Tool libraries and Fusion 360 exports", extensions: ["json", "tools"] },
            { name: "All files", extensions: ["*"] }
          ],
          properties: ["openFile"]
        });
        const file = dialog.ok ? dialog.data.filePaths?.[0] : undefined;
        if (!file || (dialog.ok && dialog.data.canceled)) return;
        /* Read bytes, not text: a Fusion `.tools` export is a zip, and a plain JSON file may carry a byte-order
         * mark that JSON.parse will not accept. The container is decided by what the file actually starts
         * with rather than by its extension, so a mislabelled file still opens. */
        const r = await window.api.store.readBinaryFile(file);
        if (!r.ok) throw new Error(r.message ?? r.code ?? "could not read the file");
        if (!r.data) throw new Error("That file could not be read");
        const bytes = new Uint8Array(r.data);
        let text: string;
        if (isZip(bytes)) text = await readToolsArchive(bytes);
        else text = new TextDecoder().decode(bytes).replace(/^﻿/, "");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          const head = text.trim().slice(0, 40).replace(/\s+/g, " ");
          throw new Error(`That file is not JSON (it starts with "${head}")`);
        }
        const { tools, unsupported, source } = extractTools(parsed);
        if (!tools.length) {
          const tail = unsupported.length
            ? `: nothing in it maps to a tool this app has (${unsupported.join(", ")})`
            : " (expected this mod's export, a tool array, a store.json, or a Fusion 360 library)";
          throw new Error(`No tools could be read from that file${tail}`);
        }
        setIncoming({ tools, unsupported, source, fileName: file.split(/[\\/]/).pop() ?? file });
      };
      if (lib.error) return <Err>{lib.error}</Err>;
      if (!lib.data) return <Loading />;
      if (incoming)
        return (
          <ImportView
            incoming={incoming.tools}
            existing={lib.data.tools}
            fileName={incoming.fileName}
            source={incoming.source}
            unsupported={incoming.unsupported}
            done={() => setIncoming(null)}
          />
        );
      return (
        <>
          <KV
            pairs={[
              ["Tools in library", String(lib.data.tools.length)],
              [
                "Loaded in the magazine",
                lib.data.tools
                  .filter((t) => typeof t.slotNum === "number" && t.slotNum > 0)
                  .sort((a, b) => Number(a.slotNum) - Number(b.slotNum))
                  .map((t) => `T${String(t.slotNum)} ${t.name}`)
                  .join(" · ") || "nothing loaded"
              ]
            ]}
          />
          {showExport ? <ExportView tools={lib.data.tools} /> : null}
          <Sub>
            Export writes a JSON file you can share or back up. Import reads that file, another machine&apos;s
            store.json, or a Fusion 360 library (a <code>.json</code> library or a zipped <code>.tools</code>
            export), working out which it is from the file itself. It then lets you pick tools and settle id and
            slot clashes.
          </Sub>
          <ModalFooter>
            <Button label={showExport ? "Hide export list" : "Export tools…"} primary onClick={() => setShowExport((v) => !v)} />
            <Button label="Import tools…" onClick={pickFile} />
            <Button label="Close" onClick={close} />
          </ModalFooter>
        </>
      );
    }

  ui.toolbar.addButton({
    id: "tools",
    title: "Tool library manager",
    icon: () => ui.icons.svg("M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"),
    order: 36,
    onClick: () => {
      let modal: Usermod.ModalHandle | null = null;
      modal = ui.react.modal("Tool library", <Root close={() => modal?.close()} />, { width: 720 });
    }
  });
})();
