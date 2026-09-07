/*
 * G-code Lab: open any .nc/.gcode/.tap file, see stats, preview what the post-processor chain will do,
 * run the app's own validator and machining-time estimate, and export through the chain.
 * Adds a "G-code Lab…" action to the MODS menu.
 */
(function gcodeLab(): void {
  const rt = window.usermodRuntime;
  rt.register({ name: "gcode-lab", version: "0.2.0" });

  rt.addStyle(
    `.usermod-lab-drop{border:2px dashed #b8bec8;border-radius:10px;padding:18px;text-align:center;color:#666;cursor:pointer}
     .usermod-lab-drop.over{border-color:#0f766e;color:#0f766e;background:rgba(15,118,110,.06)}
     .usermod-lab-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:12px}
     .usermod-lab-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
     .usermod-lab-result{margin-top:10px}
     .usermod-lab-result .bad{color:#b3261e}.usermod-lab-result .good{color:#166534}
     @media (prefers-color-scheme: dark){.usermod-lab-drop{border-color:#555;color:#aaa}}`,
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

  function open(): () => void {
    const { body, close } = rt.modal("G-code Lab", { width: 820 });
    let current: { name: string; text: string } | null = null;

    const drop = rt.el("div", { class: "usermod-lab-drop", text: "Drop a .nc / .gcode / .tap file here, or click to choose" });
    const input = rt.el("input", { type: "file", accept: ".nc,.gcode,.tap,.ngc,.cnc", style: { display: "none" } });
    const statsBox = rt.el("dl", { class: "usermod-kv" });
    const preview = rt.el("div", { class: "usermod-mono", text: "" });
    const result = rt.el("div", { class: "usermod-lab-result" });
    const buttons = {
      chain: rt.el("button", { class: "usermod-btn", text: "Preview post-processors" }),
      validate: rt.el("button", { class: "usermod-btn", text: "Validate" }),
      time: rt.el("button", { class: "usermod-btn", text: "Estimate time" }),
      export: rt.el("button", { class: "usermod-btn usermod-btn-primary", text: "Export via post-processors…" })
    };
    const setBusy = (busy: boolean): void => {
      for (const b of Object.values(buttons)) b.disabled = busy || !current;
    };
    setBusy(false);
    const kv = (pairs: [string, string][]): void => {
      statsBox.replaceChildren(...pairs.flatMap(([k, v]) => [rt.el("dt", { text: k }), rt.el("dd", { text: v })]));
    };

    async function load(file: File): Promise<void> {
      try {
        const text = await readFile(file);
        current = { name: file.name, text };
        const s = analyze(text);
        kv([
          ["File", `${file.name} (${rt.formatBytes(text.length)})`],
          ["Lines / comments", `${s.lines} / ${s.comments}`],
          ["Tools", s.tools.size ? [...s.tools].sort((a, b) => a - b).map((t) => `T${t}`).join(", ") : "—"],
          ["Feed range", rangeText(s.feeds)],
          ["Spindle range", rangeText(s.spindle)],
          ["X / Y / Z", `${boundText(s.bounds.X)}  |  ${boundText(s.bounds.Y)}  |  ${boundText(s.bounds.Z)}${s.relative ? "  (G91 present, bounds partial)" : ""}`],
          ["Program end", s.programEnd ?? "missing"],
          ["Nest header", s.header ? `${s.header.machineModel ?? "?"} · ${s.header.materialType ?? "?"} · ${s.header.stockSize ?? "?"}` : "none"]
        ]);
        preview.textContent = text.split(/\r?\n/).slice(0, 60).join("\n") + (s.lines > 60 ? "\n…" : "");
        result.replaceChildren();
        setBusy(false);
      } catch (error) {
        rt.toast(`Could not read file: ${message(error)}`, { kind: "error" });
      }
    }

    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void load(file);
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove("over");
      const file = e.dataTransfer?.files[0];
      if (file) void load(file);
    });

    const withBusy = (fn: () => Promise<void>) => async (): Promise<void> => {
      if (!current) return;
      setBusy(true);
      try {
        await fn();
      } catch (error) {
        rt.toast(message(error), { kind: "error" });
      } finally {
        setBusy(false);
      }
    };

    buttons.chain.addEventListener(
      "click",
      withBusy(async () => {
        if (!current) return;
        const r = await window.usermod.runPostprocessors("export", current.text, { fileName: current.name, filePath: current.name });
        if (!r.ok) throw new Error(r.message);
        const before = current.text.split(/\r?\n/);
        const after = r.data.split(/\r?\n/);
        let firstDiff = after.findIndex((line, i) => line !== before[i]);
        if (firstDiff < 0) firstDiff = after.length;
        const delta = after.length - before.length;
        result.replaceChildren(
          rt.el("div", { text: `Chain output: ${after.length} lines (${delta >= 0 ? "+" : ""}${delta}), ${rt.formatBytes(r.data.length)}. First change at line ${firstDiff + 1}.` }),
          rt.el("div", { class: "usermod-mono", text: after.slice(Math.max(0, firstDiff - 3), firstDiff + 40).join("\n") })
        );
      })
    );

    buttons.validate.addEventListener(
      "click",
      withBusy(async () => {
        if (!current) return;
        const slots = await toolSlotsFromStore();
        const r = await window.api.gcode.validate(current.text, slots);
        if (!r.ok) throw new Error(r.message || r.code || "validation failed");
        const tokens = r.data.result.tokens ?? [];
        const errors = tokens.filter((t) => t.level === "error");
        result.replaceChildren(
          rt.el("div", {
            class: errors.length ? "bad" : "good",
            text: errors.length
              ? `${errors.length} error(s), ${tokens.length - errors.length} other note(s). Tool slots checked: ${slots.join(", ") || "none"}`
              : `No errors. ${tokens.length} note(s).`
          }),
          rt.el("div", { class: "usermod-mono", text: tokens.slice(0, 80).map((t) => `L${t.line} ${t.level} ${t.code} ${t.value ?? ""}  ${t.msg ?? ""}`).join("\n") || "(clean)" })
        );
      })
    );

    buttons.time.addEventListener(
      "click",
      withBusy(async () => {
        if (!current) return;
        const r = await window.api.gcode.estimatedTime(current.text);
        if (!r.ok) throw new Error(r.message || r.code || "estimate failed");
        const t = r.data.motionTime;
        result.replaceChildren(rt.el("div", { text: `Estimated motion time: ${typeof t === "number" ? rt.formatDuration(t) : JSON.stringify(t)} (raw: ${JSON.stringify(t)})` }));
      })
    );

    buttons.export.addEventListener(
      "click",
      withBusy(async () => {
        if (!current) return;
        const dialog = await window.api.dialog.showSave({
          defaultPath: current.name.replace(/(\.[^.]+)?$/, "-post$1"),
          filters: [{ name: "G-code", extensions: ["nc", "gcode", "tap"] }]
        });
        if (!dialog.ok || !dialog.data.filePath || dialog.data.canceled) return;
        const w = await window.api.store.writeFile(dialog.data.filePath, current.text); // the loader's export hook applies the chain
        if (!w.ok) throw new Error(w.message || w.code || "write failed");
        rt.toast(`Exported via post-processors to ${dialog.data.filePath}`, { kind: "success", duration: 5000 });
      })
    );

    body.append(drop, input, rt.el("div", { class: "usermod-lab-grid" }, [statsBox, preview]), rt.el("div", { class: "usermod-lab-actions" }, Object.values(buttons)), result);
    return close;
  }

  rt.menu.addAction({
    id: "gcode-lab",
    label: "G-code Lab…",
    section: "Tools",
    order: 10,
    title: "Inspect, validate and post-process any G-code file",
    onClick: ({ close }) => {
      close();
      open();
    }
  });
  window.usermodGcodeLab = { open };
})();
