/*
 * G-code Lab: open any .nc/.gcode/.tap file, see stats, preview what the post-processor chain will do,
 * run the app's own validator and machining-time estimate, and export through the chain.
 * Adds a "G-code Lab…" action to the MODS menu. The dialog is a React component built on the kit.
 */
(function gcodeLab(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { KV, Mono, Button } = ui.react;
  rt.register({ name: "gcode-lab", version: "0.3.0" });

  rt.addStyle(
    `.usermod-lab-drop{border:2px dashed #b8bec8;border-radius:10px;padding:18px;text-align:center;color:#666;cursor:pointer}
     .usermod-lab-drop.over{border-color:#0f766e;color:#0f766e;background:rgba(15,118,110,.06)}
     .usermod-lab-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:12px}
     .usermod-lab-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
     .usermod-lab-result{margin-top:10px}
     html[data-theme=dark] .usermod-lab-drop{border-color:#555;color:#aaa}`,
    "gcode-lab"
  );

  type Range = [min: number, max: number];
  interface NestHeader {
    machineModel?: string;
    materialType?: string;
    stockSize?: string;
  }
  interface Stats {
    lines: number;
    bytes: number;
    comments: number;
    tools: Set<number>;
    feeds: number[];
    spindle: number[];
    bounds: Record<"X" | "Y" | "Z", Range>;
    relative: boolean;
    programEnd: string | null;
    header: NestHeader | null;
  }
  const WORD = /([A-Z])([-+]?\d*\.?\d+)/g;
  const isAxis = (letter: string): letter is "X" | "Y" | "Z" => letter === "X" || letter === "Y" || letter === "Z";

  function analyze(text: string): Stats {
    const lines = text.split(/\r?\n/);
    const stats: Stats = {
      lines: lines.length,
      bytes: text.length,
      comments: 0,
      tools: new Set(),
      feeds: [],
      spindle: [],
      bounds: { X: [Infinity, -Infinity], Y: [Infinity, -Infinity], Z: [Infinity, -Infinity] },
      relative: false,
      programEnd: null,
      header: null
    };
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("(") || trimmed.startsWith(";")) {
        stats.comments += 1;
        if (!stats.header && trimmed.startsWith("({")) {
          try {
            stats.header = JSON.parse(trimmed.slice(1, trimmed.lastIndexOf(")"))) as NestHeader;
          } catch {
            /* not our header */
          }
        }
        continue;
      }
      const code = trimmed.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();
      if (/\bG91\b/.test(code)) stats.relative = true;
      if (/\bM30\b|\bM2\b/.test(code)) stats.programEnd = trimmed;
      let match: RegExpExecArray | null;
      WORD.lastIndex = 0;
      while ((match = WORD.exec(code))) {
        const letter = match[1]!;
        const num = Number(match[2]);
        if (letter === "T") stats.tools.add(num);
        else if (letter === "F") stats.feeds.push(num);
        else if (letter === "S") stats.spindle.push(num);
        else if (isAxis(letter) && !stats.relative) {
          const range = stats.bounds[letter];
          if (num < range[0]) range[0] = num;
          if (num > range[1]) range[1] = num;
        }
      }
    }
    return stats;
  }
  const rangeText = (arr: number[]): string => (arr.length ? `${Math.min(...arr)} – ${Math.max(...arr)}` : "—");
  const boundText = (b: Range): string => (Number.isFinite(b[0]) ? `${b[0].toFixed(2)} … ${b[1].toFixed(2)}` : "—");
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  function readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsText(file);
    });
  }
  async function toolSlotsFromStore(): Promise<string[]> {
    try {
      const store = await window.api.store.read();
      if (!store.ok) return [];
      const tools = store.data.toolLibary?.cutLibrarySettings ?? [];
      return tools.map((t) => String(t.slotNum)).filter(Boolean);
    } catch {
      return [];
    }
  }

  interface Loaded {
    name: string;
    text: string;
    stats: Stats;
  }
  interface Outcome {
    tone: "neutral" | "good" | "bad";
    summary: string;
    detail?: string;
  }

  function DropZone({ onFile }: { onFile(file: File): void }): React.JSX.Element {
    const [over, setOver] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement>(null);
    return (
      <>
        <div
          className={`usermod-lab-drop${over ? " over" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            const file = e.dataTransfer.files[0];
            if (file) onFile(file);
          }}
        >
          Drop a .nc / .gcode / .tap file here, or click to choose
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".nc,.gcode,.tap,.ngc,.cnc"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = "";
          }}
        />
      </>
    );
  }

  function Lab(): React.JSX.Element {
    const [current, setCurrent] = React.useState<Loaded | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [outcome, setOutcome] = React.useState<Outcome | null>(null);

    const load = async (file: File): Promise<void> => {
      try {
        const text = await readFile(file);
        setCurrent({ name: file.name, text, stats: analyze(text) });
        setOutcome(null);
      } catch (error) {
        rt.toast(`Could not read file: ${message(error)}`, { kind: "error" });
      }
    };
    const action = (fn: (loaded: Loaded) => Promise<Outcome | null>) => async (): Promise<void> => {
      if (!current) return;
      setBusy(true);
      try {
        const result = await fn(current);
        if (result) setOutcome(result);
      } finally {
        setBusy(false);
      }
    };

    const previewChain = action(async (loaded) => {
      const r = await window.usermod.runPostprocessors("export", loaded.text, { fileName: loaded.name, filePath: loaded.name });
      if (!r.ok) throw new Error(r.message);
      const before = loaded.text.split(/\r?\n/);
      const after = r.data.split(/\r?\n/);
      let firstDiff = after.findIndex((line, i) => line !== before[i]);
      if (firstDiff < 0) firstDiff = after.length;
      const delta = after.length - before.length;
      return {
        tone: "neutral",
        summary: `Chain output: ${after.length} lines (${delta >= 0 ? "+" : ""}${delta}), ${rt.formatBytes(r.data.length)}. First change at line ${firstDiff + 1}.`,
        detail: after.slice(Math.max(0, firstDiff - 3), firstDiff + 40).join("\n")
      };
    });
    const validate = action(async (loaded) => {
      const slots = await toolSlotsFromStore();
      const r = await window.api.gcode.validate(loaded.text, slots);
      if (!r.ok) throw new Error(r.message || r.code || "validation failed");
      const tokens = r.data.result.tokens ?? [];
      const errors = tokens.filter((t) => t.level === "error");
      return {
        tone: errors.length ? "bad" : "good",
        summary: errors.length ? `${errors.length} error(s), ${tokens.length - errors.length} other note(s). Tool slots checked: ${slots.join(", ") || "none"}` : `No errors. ${tokens.length} note(s).`,
        detail: tokens.slice(0, 80).map((t) => `L${t.line} ${t.level} ${t.code} ${t.value ?? ""}  ${t.msg ?? ""}`).join("\n") || "(clean)"
      };
    });
    const estimate = action(async (loaded) => {
      const r = await window.api.gcode.estimatedTime(loaded.text);
      if (!r.ok) throw new Error(r.message || r.code || "estimate failed");
      const t = r.data.motionTime;
      return { tone: "neutral", summary: `Estimated motion time: ${typeof t === "number" ? rt.formatDuration(t) : JSON.stringify(t)} (raw: ${JSON.stringify(t)})` };
    });
    const exportViaChain = action(async (loaded) => {
      const dialog = await window.api.dialog.showSave({
        defaultPath: loaded.name.replace(/(\.[^.]+)?$/, "-post$1"),
        filters: [{ name: "G-code", extensions: ["nc", "gcode", "tap"] }]
      });
      if (!dialog.ok || !dialog.data.filePath || dialog.data.canceled) return null;
      const w = await window.api.store.writeFile(dialog.data.filePath, loaded.text); // the loader's export hook applies the chain
      if (!w.ok) throw new Error(w.message || w.code || "write failed");
      rt.toast(`Exported via post-processors to ${dialog.data.filePath}`, { kind: "success", duration: 5000 });
      return null;
    });

    const s = current?.stats;
    const pairs: [string, React.ReactNode][] =
      current && s
        ? [
            ["File", `${current.name} (${rt.formatBytes(current.text.length)})`],
            ["Lines / comments", `${s.lines} / ${s.comments}`],
            ["Tools", s.tools.size ? [...s.tools].sort((a, b) => a - b).map((t) => `T${t}`).join(", ") : "—"],
            ["Feed range", rangeText(s.feeds)],
            ["Spindle range", rangeText(s.spindle)],
            ["X / Y / Z", `${boundText(s.bounds.X)}  |  ${boundText(s.bounds.Y)}  |  ${boundText(s.bounds.Z)}${s.relative ? "  (G91 present, bounds partial)" : ""}`],
            ["Program end", s.programEnd ?? "missing"],
            ["Nest header", s.header ? `${s.header.machineModel ?? "?"} · ${s.header.materialType ?? "?"} · ${s.header.stockSize ?? "?"}` : "none"]
          ]
        : [];
    const head = current ? current.text.split(/\r?\n/).slice(0, 60).join("\n") + (current.stats.lines > 60 ? "\n…" : "") : "";
    const disabled = busy || !current;

    return (
      <>
        <DropZone onFile={(file) => void load(file)} />
        <div className="usermod-lab-grid">
          <KV pairs={pairs} />
          <Mono>{head}</Mono>
        </div>
        <div className="usermod-lab-actions">
          <Button label="Preview post-processors" disabled={disabled} onClick={previewChain} />
          <Button label="Validate" disabled={disabled} onClick={validate} />
          <Button label="Estimate time" disabled={disabled} onClick={estimate} />
          <Button label="Export via post-processors…" primary disabled={disabled} onClick={exportViaChain} />
        </div>
        {outcome ? (
          <div className="usermod-lab-result">
            <div className={outcome.tone === "bad" ? "usermod-err" : outcome.tone === "good" ? "usermod-ok" : undefined}>{outcome.summary}</div>
            {outcome.detail !== undefined ? <Mono>{outcome.detail}</Mono> : null}
          </div>
        ) : null}
      </>
    );
  }

  function open(): () => void {
    const modal = ui.react.modal("G-code Lab", <Lab />, { width: 820 });
    return modal.close;
  }

  ui.toolbar.addButton({
    id: "gcode-lab",
    title: "G-code Lab: inspect, validate and post-process any file",
    icon: () => ui.icons.svg("M9 2h6v2h-1v3.4l4.7 9.3A3 3 0 0 1 16 21H8a3 3 0 0 1-2.7-4.3L10 7.4V4H9V2zm3 7.9-3.2 6.4h6.4L12 9.9z"),
    order: 30,
    onClick: () => {
      open();
    }
  });
  window.usermodGcodeLab = { open };
})();
