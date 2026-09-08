/*
 * Toolpath colour: the Preview tab draws each toolpath as one three.js Line whose colour lives per vertex
 * (linear-space RGB, usually packed as bytes), with rapids in a fixed tan. This mod rewrites those vertex
 * colours in place:
 *   depth   green (surface) → yellow → red (deepest) by Z, rapids kept
 *   path    a distinct colour per toolpath row (the app colours by tool number, which merges same-tool paths)
 *   off     the app's own colours (restored from a copy)
 * and can dim every other path while the mouse is over a row in the toolpath list. Reads the scene through
 * the installer's scene patch (globalThis.__usermodSceneManagers) and re-applies when paths are (re)loaded.
 *
 * mods.json settings ("toolpath-color"): mode ("depth" | "path" | "off", default "depth"), highlight (true)
 */
(function toolpathColor(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, Select, Toggle, KV, useInfo } = ui.react;
  rt.register({ name: "toolpath-color", version: "0.1.0" });

  type Mode = "depth" | "path" | "off";
  let mode: Mode = "depth";
  let highlightEnabled = true;
  const GROUP = "previewGcodeGroup";
  const RAPID_HEX = "#cda28a"; // the app's G0 colour (parse worker GCODE_TOOL_COLOR_HEX.G0)

  /* ------------------------------------------------------------- colours */
  type RGB = [number, number, number];
  const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const hexToLinear = (hex: string): RGB => {
    const n = parseInt(hex.slice(1), 16);
    return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
  };
  const RAPID = hexToLinear(RAPID_HEX);
  const PATH_PALETTE = ["#13aa45", "#4889ff", "#7749fa", "#eb52a0", "#f59e0b", "#06b6d4", "#84cc16", "#ef4444", "#a855f7", "#14b8a6"].map(hexToLinear);
  /** Depth ramp in sRGB: green → yellow → orange → red, then converted to linear. */
  const ramp = (t: number): RGB => {
    const stops: [number, RGB][] = [
      [0, [0.15, 0.75, 0.3]],
      [0.4, [0.95, 0.85, 0.15]],
      [0.7, [0.98, 0.5, 0.1]],
      [1, [0.9, 0.1, 0.1]]
    ];
    const x = Math.min(1, Math.max(0, t));
    for (let i = 1; i < stops.length; i += 1) {
      const [t0, c0] = stops[i - 1]!;
      const [t1, c1] = stops[i]!;
      if (x <= t1) {
        const k = (x - t0) / (t1 - t0);
        return [srgbToLinear(c0[0] + (c1[0] - c0[0]) * k), srgbToLinear(c0[1] + (c1[1] - c0[1]) * k), srgbToLinear(c0[2] + (c1[2] - c0[2]) * k)];
      }
    }
    return [srgbToLinear(0.9), srgbToLinear(0.1), srgbToLinear(0.1)];
  };

  /* ------------------------------------------------------- scene access */
  type ColorArray = Uint8Array | Float32Array;
  interface Painted {
    original: ColorArray;
    byte: boolean;
  }
  const painted = new WeakMap<UsermodGeometryLike, Painted>();
  const lineTool = new WeakMap<UsermodObject3DLike, string>();

  function managers(): UsermodSceneManagerLike[] {
    return [...(globalThis.__usermodSceneManagers ?? [])].filter((m) => !m.disposed);
  }
  function toolpathLines(mgr: UsermodSceneManagerLike): UsermodObject3DLike[] {
    const out: UsermodObject3DLike[] = [];
    mgr.scene.traverse((o) => {
      if (o.name === GROUP) for (const child of o.children) if (child.geometry && typeof child.userData.gcodeId === "string") out.push(child);
    });
    return out;
  }
  function colorArray(geometry: UsermodGeometryLike): { attr: UsermodBufferAttributeLike; arr: ColorArray } | null {
    const attr = geometry.getAttribute("color");
    if (!attr) return null;
    const arr = attr.array;
    if (arr instanceof Uint8Array || arr instanceof Float32Array) return { attr, arr };
    return null;
  }
  function remember(geometry: UsermodGeometryLike): Painted | null {
    const cur = painted.get(geometry);
    if (cur) return cur;
    const c = colorArray(geometry);
    if (!c) return null;
    const entry: Painted = { original: c.arr instanceof Uint8Array ? Uint8Array.from(c.arr) : Float32Array.from(c.arr), byte: c.arr instanceof Uint8Array };
    painted.set(geometry, entry);
    return entry;
  }
  const readOriginal = (p: Painted, i: number): RGB => {
    const o = i * 3;
    const k = p.byte ? 1 / 255 : 1;
    return [(p.original[o] ?? 0) * k, (p.original[o + 1] ?? 0) * k, (p.original[o + 2] ?? 0) * k];
  };
  const isRapid = (c: RGB): boolean => Math.abs(c[0] - RAPID[0]) < 0.02 && Math.abs(c[1] - RAPID[1]) < 0.02 && Math.abs(c[2] - RAPID[2]) < 0.02;
  function write(geometry: UsermodGeometryLike, color: (i: number, original: RGB) => RGB): void {
    const p = remember(geometry);
    const c = colorArray(geometry);
    if (!p || !c) return;
    const count = Math.floor(c.arr.length / 3);
    for (let i = 0; i < count; i += 1) {
      const [r, g, b] = color(i, readOriginal(p, i));
      const o = i * 3;
      if (c.arr instanceof Uint8Array) {
        c.arr[o] = Math.round(Math.min(1, r) * 255);
        c.arr[o + 1] = Math.round(Math.min(1, g) * 255);
        c.arr[o + 2] = Math.round(Math.min(1, b) * 255);
      } else {
        c.arr[o] = r;
        c.arr[o + 1] = g;
        c.arr[o + 2] = b;
      }
    }
    c.attr.needsUpdate = true;
  }
  function zRange(lines: UsermodObject3DLike[]): [number, number] {
    let min = Infinity;
    let max = -Infinity;
    for (const line of lines) {
      const pos = line.geometry?.getAttribute("position");
      const p = line.geometry ? remember(line.geometry) : null;
      if (!pos || !p) continue;
      const count = Math.floor(pos.array.length / 3);
      for (let i = 0; i < count; i += 1) {
        if (isRapid(readOriginal(p, i))) continue;
        const z = pos.array[i * 3 + 2] ?? 0;
        if (z < min) min = z;
        if (z > max) max = z;
      }
    }
    return Number.isFinite(min) && max > min ? [min, max] : [0, 0];
  }
  /** Tool label per gcode id from the Preview tab's own list rows ("T2~6mm"). */
  function toolOf(gcodeId: string): string {
    const row = document.querySelector(`[data-gcode-id="${gcodeId.replace(/"/g, '\\"')}"]`);
    const m = row ? /\bT(\d+)/.exec(row.textContent ?? "") : null;
    return m ? `T${m[1]}` : "";
  }

  let lastRange: [number, number] = [0, 0];
  let pathColors = new Map<string, number>();
  function apply(hover: string | null = null): void {
    for (const mgr of managers()) {
      const lines = toolpathLines(mgr);
      if (!lines.length) continue;
      if (mode === "depth") lastRange = zRange(lines);
      const ids = lines.map((l) => String(l.userData.gcodeId));
      for (const id of ids) if (!pathColors.has(id)) pathColors.set(id, pathColors.size % PATH_PALETTE.length);
      const [zMin, zMax] = lastRange;
      for (const line of lines) {
        const geometry = line.geometry;
        if (!geometry) continue;
        const id = String(line.userData.gcodeId);
        lineTool.set(line, toolOf(id));
        const pos = geometry.getAttribute("position");
        const dim = hover !== null && hover !== id;
        const pathColor = PATH_PALETTE[pathColors.get(id) ?? 0]!;
        write(geometry, (i, original) => {
          let c: RGB = original;
          if (!isRapid(original)) {
            if (mode === "depth" && pos && zMax > zMin) c = ramp((zMax - (pos.array[i * 3 + 2] ?? zMax)) / (zMax - zMin));
            else if (mode === "path") c = pathColor;
          }
          return dim ? [c[0] * 0.12 + 0.02, c[1] * 0.12 + 0.02, c[2] * 0.12 + 0.02] : c;
        });
      }
      mgr.requestRender();
    }
  }

  // Re-apply when the app (re)builds toolpath geometry: cheap signature poll.
  let signature = "";
  let hovered: string | null = null;
  setInterval(() => {
    const sig = managers()
      .map((m) => toolpathLines(m).map((l) => `${String(l.userData.gcodeId)}:${painted.has(l.geometry!) ? "p" : "n"}`).join(","))
      .join("|");
    if (sig !== signature) {
      signature = sig;
      if (mode !== "off" || hovered) apply(hovered);
    }
  }, 1000);
  document.addEventListener("mouseover", (e) => {
    if (!highlightEnabled) return;
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-gcode-id]") : null;
    const id = row?.dataset.gcodeId ?? null;
    if (id === hovered) return;
    hovered = id;
    apply(hovered);
  });
  document.addEventListener("mouseleave", () => {
    if (hovered) {
      hovered = null;
      apply(null);
    }
  }, true);

  void window.usermod.info().then((r) => {
    if (!r.ok) return;
    const s = r.data.config.settings["toolpath-color"] ?? {};
    mode = s.mode === "path" || s.mode === "off" ? s.mode : "depth";
    highlightEnabled = s.highlight !== false;
    apply();
  });

  function Panel(): React.JSX.Element {
    const [, force] = React.useState(0);
    const { data: info } = useInfo();
    const setMode = async (m: Mode): Promise<void> => {
      mode = m;
      apply(hovered);
      force((n) => n + 1);
      await window.usermod.setSettings("toolpath-color", { ...(info?.config.settings["toolpath-color"] ?? {}), mode: m, highlight: highlightEnabled });
    };
    const setHighlight = async (on: boolean): Promise<void> => {
      highlightEnabled = on;
      if (!on && hovered) {
        hovered = null;
        apply(null);
      }
      force((n) => n + 1);
      await window.usermod.setSettings("toolpath-color", { ...(info?.config.settings["toolpath-color"] ?? {}), mode, highlight: on });
    };
    const lines = managers().flatMap(toolpathLines);
    const tools = [...new Set(lines.map((l) => lineTool.get(l) ?? ""))].filter(Boolean);
    return (
      <>
        <h3>Toolpath colour</h3>
        <Select label="Colour by" options={[{ value: "depth", label: "Depth (green → red)" }, { value: "path", label: "Operation (one colour per path)" }, { value: "off", label: "App default (by tool)" }]} value={mode} onChange={(v) => void setMode(v === "path" || v === "off" ? v : "depth")} />
        <Toggle label="Highlight the path under the mouse in the list" checked={highlightEnabled} onChange={(on) => void setHighlight(on)} />
        <KV
          pairs={[
            ["Toolpaths in scene", String(lines.length)],
            ["Tools", tools.join(", ") || "—"],
            ["Depth range", mode === "depth" && lastRange[1] > lastRange[0] ? `Z ${lastRange[0].toFixed(2)} … ${lastRange[1].toFixed(2)} (red = deepest)` : "—"],
            ["Scene patch", globalThis.__usermodSceneManagers ? "present" : "missing: re-run the installer"]
          ]}
        />
        <Sub>Rapids keep the app's tan colour. Colours are re-applied when paths reload; the app's machining progress overlay still paints executed segments grey.</Sub>
        <Row>
          <Button label="Re-apply" onClick={() => apply(hovered)} />
        </Row>
      </>
    );
  }
  ui.toolbar.addButton({
    id: "toolpath-color",
    title: "Toolpath colour",
    icon: () => ui.icons.svg("M12 2.5a9.5 9.5 0 0 0 0 19c1.1 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8h2.1a4.8 4.8 0 0 0 4.8-4.8c0-4.6-4.3-8.2-9.5-8.2zM6.5 12a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"),
    order: 48,
    onClick: (button) => {
      ui.react.popover(button, <Panel />, { width: 400 });
    }
  });
})();
