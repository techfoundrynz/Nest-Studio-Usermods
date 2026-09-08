/*
 * Cycles: generators for machining cycles the CAM does not offer, written as plain G-code the machine already
 * understands (G0/G1 plus G2/G3 helical arcs with I/J centre offsets and a Z word):
 *   - Thread milling   internal / external, right- or left-hand, single-form thread mill, radial passes, spring pass
 *   - Helical hole     holes larger than any drill by helical interpolation, roughing radii plus a finish pass
 *   - Surfacing        parametric raster facing for the spoilboard or a stock top
 * Every program can be validated with the app's own checker, time-estimated, previewed top-down, copied, or
 * exported through the normal post-processor chain. "Cycles…" in the MODS menu (Tools).
 *
 * Suits plastics, aluminium and threaded inserts far more than wood for threads. Always check the preview
 * and run the first program with the spindle off or above the part.
 * mods.json settings ("cycles"): last-used parameters per tab (written on Generate), plus "safeZ", "rpm".
 */
(function cycles(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Section, Sub, Row, Button, Toggle, Select, Input, Mono, KV, Err } = ui.react;
  rt.register({ name: "cycles", version: "0.1.0" });

  rt.addStyle(
    `.usermod-cyc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:0 14px}
     .usermod-cyc-grid .usermod-field{margin:6px 0}
     .usermod-cyc-tabs{display:flex;gap:6px;margin-bottom:8px}
     .usermod-cyc-tabs .usermod-btn[data-active=true]{background:#0f766e;color:#fff}
     .usermod-cyc-out{display:grid;grid-template-columns:1fr 300px;gap:14px;margin-top:10px}
     .usermod-cyc-out .usermod-mono{max-height:320px}
     .usermod-cyc-canvas{display:block;width:300px;height:300px;border:1px solid #cfd4dc;border-radius:8px;background:#fff}
     .usermod-cyc-side{height:120px;margin-top:8px}
     html[data-theme=dark] .usermod-cyc-canvas{border-color:#444;background:#1c1c1c}`,
    "cycles"
  );

  /* ---------------------------------------------------------------- numbers */
  const fmt = (n: number): string => {
    const s = (Math.abs(n) < 1e-9 ? 0 : n).toFixed(3);
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  };
  const num = (s: string, fallback = 0): number => {
    const n = Number(String(s).trim().replace(",", "."));
    return Number.isFinite(n) ? n : fallback;
  };
  /**
   * Evenly spaced values from `from` to `to` with a step no larger than `max`. Stepping by `+= max` and then
   * appending the end instead lands the last two values microns apart when the span is nearly a multiple of
   * the step, which shows up as two passes cutting the same line.
   */
  function spread(from: number, to: number, max: number): number[] {
    const span = to - from;
    if (!(Math.abs(span) > 1e-9)) return [from];
    const steps = Math.max(1, Math.ceil(Math.abs(span) / Math.max(1e-6, max)));
    return Array.from({ length: steps + 1 }, (_, i) => from + (span * i) / steps);
  }

  interface Common {
    safeZ: number;
    rpm: number;
    feed: number;
    plungeFeed: number;
    coolant: boolean;
  }
  interface Point {
    x: number;
    y: number;
  }
  interface Program {
    name: string;
    lines: string[];
    warnings: string[];
  }
  class Emitter {
    readonly lines: string[] = [];
    readonly warnings: string[] = [];
    constructor(private readonly common: Common, title: string) {
      this.lines.push(`(usermod cycles: ${title})`, `(generated ${new Date().toISOString().slice(0, 16).replace("T", " ")})`, "G21 G90 G17 G94", `S${fmt(common.rpm)} M3`);
      if (common.coolant) this.lines.push("M8");
      this.lines.push(`G0 Z${fmt(common.safeZ)}`);
    }
    comment(text: string): void {
      this.lines.push(`(${text.replace(/[()]/g, "")})`);
    }
    rapid(p: Partial<Point> & { z?: number }): void {
      this.lines.push(`G0${p.x !== undefined ? ` X${fmt(p.x)}` : ""}${p.y !== undefined ? ` Y${fmt(p.y)}` : ""}${p.z !== undefined ? ` Z${fmt(p.z)}` : ""}`);
    }
    line(p: Partial<Point> & { z?: number }, feed: number): void {
      this.lines.push(`G1${p.x !== undefined ? ` X${fmt(p.x)}` : ""}${p.y !== undefined ? ` Y${fmt(p.y)}` : ""}${p.z !== undefined ? ` Z${fmt(p.z)}` : ""} F${fmt(feed)}`);
    }
    /** Arc to (x, y[, z]) with centre offset (i, j) from the current point. cw: G2, else G3. */
    arc(cw: boolean, end: Point & { z?: number }, i: number, j: number, feed: number): void {
      this.lines.push(`${cw ? "G2" : "G3"} X${fmt(end.x)} Y${fmt(end.y)}${end.z !== undefined ? ` Z${fmt(end.z)}` : ""} I${fmt(i)} J${fmt(j)} F${fmt(feed)}`);
    }
    finish(): string[] {
      this.lines.push("M5");
      if (this.common.coolant) this.lines.push("M9");
      this.lines.push(`G0 Z${fmt(this.common.safeZ)}`, "M30");
      return this.lines;
    }
  }

  /* --------------------------------------------------------- thread milling */
  interface ThreadParams extends Common {
    kind: "internal" | "external";
    hand: "right" | "left";
    cut: "climb" | "conventional";
    majorDiameter: number;
    pitch: number;
    length: number;
    cutterDiameter: number;
    passes: number;
    springPass: boolean;
    topZ: number;
    centers: Point[];
    preMill: boolean;
    preMillPitch: number;
  }
  /** ISO metric: thread depth 0.5413 P, minor diameter D - 1.0825 P. */
  const threadDepthOf = (pitch: number): number => 0.5413 * pitch;
  /**
   * Z of the end of each full revolution climbing from `bottom` to `top`, one pitch per turn. A thread whose
   * length is not a whole number of pitches gets a last, shorter turn that stops exactly at the top rather
   * than cutting above it.
   */
  function helixTurns(bottom: number, top: number, pitch: number): number[] {
    const out: number[] = [];
    for (let z = bottom + pitch; z < top - 1e-6; z += pitch) out.push(z);
    out.push(top);
    return out;
  }

  function generateThread(p: ThreadParams): Program {
    const em = new Emitter(p, `${p.kind} ${p.hand}-hand thread M${fmt(p.majorDiameter)}x${fmt(p.pitch)}, ${p.cut}`);
    const depth = threadDepthOf(p.pitch);
    const minor = p.majorDiameter - 2 * depth;
    if (p.kind === "internal" && p.cutterDiameter >= minor - 0.2) em.warnings.push(`Cutter Ø${fmt(p.cutterDiameter)} does not fit the minor diameter Ø${fmt(minor)} with clearance.`);
    if (p.pitch <= 0 || p.length <= 0 || p.majorDiameter <= 0 || p.cutterDiameter <= 0) em.warnings.push("Diameter, pitch, length and cutter diameter must all be positive.");
    if (p.length > 4 * p.cutterDiameter) em.warnings.push("Thread length is more than 4x the cutter diameter: check the thread mill's flute length.");
    if (!p.centers.length) em.warnings.push("No thread positions given.");
    const finalR = p.kind === "internal" ? p.majorDiameter / 2 - p.cutterDiameter / 2 : p.majorDiameter / 2 + p.cutterDiameter / 2;
    if (finalR <= 0) em.warnings.push("Cutter is too large for this thread.");
    // Right-hand internal climb: counter-clockwise (G3) helix going up. External swaps direction; left-hand and conventional each swap again.
    let ccw = p.kind === "internal";
    if (p.hand === "left") ccw = !ccw;
    if (p.cut === "conventional") ccw = !ccw;
    const bottom = p.topZ - p.length;
    const passes = Math.max(1, Math.round(p.passes));
    /* Equal radial increments, so each pass removes about the same amount and the numbers are predictable
     * (passes of depth/passes mm). The tool reaches full thread depth only on the last pass. */
    const radii: number[] = [];
    for (let i = 1; i <= passes; i += 1) {
      const cut = (depth * i) / passes;
      radii.push(p.kind === "internal" ? finalR - depth + cut : finalR + depth - cut);
    }
    if (p.springPass) radii.push(finalR); // a second pass at full size, cleaning up tool deflection
    if (p.kind === "internal" && !p.preMill) em.warnings.push("Internal thread without pre-milling: the hole must already be there, at least the cutter diameter wide, because the first move plunges at the centre.");
    const lead = Math.max(1, p.cutterDiameter * 0.5);

    if (p.preMill && p.kind === "internal") {
      const holeR = minor / 2 - 0.1 - p.cutterDiameter / 2;
      if (holeR <= 0) em.warnings.push("Pre-milling skipped: cutter does not fit inside the minor diameter.");
      else {
        em.comment(`pre-mill holes to minor diameter ${fmt(minor - 0.2)}`);
        for (const c of p.centers) helixHole(em, p, c, [holeR], p.length + 0.2, p.preMillPitch, p.topZ, true);
      }
    }
    for (const [ci, c] of p.centers.entries()) {
      em.comment(`thread ${ci + 1} at X${fmt(c.x)} Y${fmt(c.y)}`);
      for (const [ri, r] of radii.entries()) {
        em.comment(ri === radii.length - 1 && p.springPass ? "spring pass" : `pass ${ri + 1} of ${radii.length}`);
        if (p.kind === "internal") {
          em.rapid({ x: c.x, y: c.y });
          em.rapid({ z: Math.min(p.safeZ, p.topZ + 2) });
          em.line({ z: bottom }, p.plungeFeed);
          // Tangential lead-in: half circle from the centre to the start point on the thread radius.
          em.arc(!ccw, { x: c.x + r, y: c.y }, r / 2, 0, p.feed);
          for (const z of helixTurns(bottom, p.topZ, p.pitch)) em.arc(!ccw, { x: c.x + r, y: c.y, z }, -r, 0, p.feed);
          em.arc(!ccw, { x: c.x, y: c.y }, -r / 2, 0, p.feed);
          em.rapid({ z: p.safeZ });
        } else {
          em.rapid({ x: c.x + r + lead, y: c.y });
          em.rapid({ z: Math.min(p.safeZ, p.topZ + 2) });
          em.line({ z: bottom }, p.plungeFeed);
          em.line({ x: c.x + r, y: c.y }, p.feed);
          for (const z of helixTurns(bottom, p.topZ, p.pitch)) em.arc(!ccw, { x: c.x + r, y: c.y, z }, -r, 0, p.feed);
          em.line({ x: c.x + r + lead, y: c.y }, p.feed);
          em.rapid({ z: p.safeZ });
        }
      }
    }
    return { name: `thread-M${fmt(p.majorDiameter)}x${fmt(p.pitch)}-${p.kind}`, lines: em.finish(), warnings: em.warnings };
  }

  /* --------------------------------------------------------- helical holes */
  interface HoleParams extends Common {
    diameter: number;
    depth: number;
    cutterDiameter: number;
    pitch: number;
    stepoverPct: number;
    finishPass: boolean;
    finishAllowance: number;
    climb: boolean;
    topZ: number;
    centers: Point[];
  }
  /** Helix down at each radius (small to large), flat circle at the bottom, back to the cleared centre, retract. */
  function helixHole(em: Emitter, p: Common & { climb?: boolean; cutterDiameter: number }, c: Point, radii: number[], depth: number, pitch: number, topZ: number, ccw: boolean): void {
    const bottom = topZ - depth;
    // Turn ends, evenly spread so the last turn is not a sliver and the final one lands exactly on the floor.
    const levels = spread(topZ, bottom, pitch).slice(1);
    for (const r of radii) {
      em.rapid({ x: c.x + r, y: c.y });
      em.rapid({ z: Math.min(p.safeZ, topZ + 1) });
      em.line({ z: topZ }, p.plungeFeed);
      for (const z of levels) em.arc(!ccw, { x: c.x + r, y: c.y, z }, -r, 0, p.feed);
      em.arc(!ccw, { x: c.x + r, y: c.y }, -r, 0, p.feed); // flatten the bottom
      em.line({ x: c.x, y: c.y }, p.feed);
      em.rapid({ z: p.safeZ });
    }
  }
  function generateHole(p: HoleParams): Program {
    const em = new Emitter(p, `helical hole Ø${fmt(p.diameter)} x ${fmt(p.depth)} deep, cutter Ø${fmt(p.cutterDiameter)}`);
    const finalR = p.diameter / 2 - p.cutterDiameter / 2;
    if (finalR <= 0.05) em.warnings.push("Hole diameter must be larger than the cutter diameter.");
    if (p.depth <= 0 || p.pitch <= 0) em.warnings.push("Depth and pitch must be positive.");
    if (p.pitch > p.cutterDiameter * 0.3) em.warnings.push("Pitch (Z per revolution) above 30% of the cutter diameter is aggressive for a plain end mill.");
    if (!p.centers.length) em.warnings.push("No hole positions given.");
    const roughR = p.finishPass ? Math.max(0.05, finalR - p.finishAllowance) : finalR;
    const step = Math.max(0.2, p.cutterDiameter * (p.stepoverPct / 100));
    // First radius also clears the centre (a cutter orbiting at 0.45 D covers it); then out to the last
    // roughing radius in even steps, so no two helices land on the same circle.
    const first = Math.min(roughR, p.cutterDiameter * 0.45);
    const radii = spread(first, roughR, step);
    for (const [ci, c] of p.centers.entries()) {
      em.comment(`hole ${ci + 1} at X${fmt(c.x)} Y${fmt(c.y)}: ${radii.length} roughing pass(es)${p.finishPass && finalR > roughR ? " + finish" : ""}`);
      helixHole(em, p, c, radii, p.depth, p.pitch, p.topZ, p.climb);
      if (p.finishPass && finalR > roughR) {
        // Same helix at the final radius: a light radial cut down the whole wall, not one full-depth turn.
        em.comment(`finish pass at Ø${fmt(p.diameter)} (${fmt(p.finishAllowance)} mm radial)`);
        helixHole(em, p, c, [finalR], p.depth, p.pitch, p.topZ, p.climb);
      }
    }
    return { name: `hole-D${fmt(p.diameter)}x${fmt(p.depth)}`, lines: em.finish(), warnings: em.warnings };
  }

  /* -------------------------------------------------------------- surfacing */
  interface SurfaceParams extends Common {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    cutterDiameter: number;
    stepoverPct: number;
    depthPerPass: number;
    totalDepth: number;
    topZ: number;
    direction: "x" | "y";
    pattern: "zigzag" | "oneway";
    overhang: number;
  }
  function generateSurface(p: SurfaceParams): Program {
    const em = new Emitter(p, `surfacing ${fmt(p.x1 - p.x0)} x ${fmt(p.y1 - p.y0)} mm, ${fmt(p.totalDepth)} mm deep, cutter Ø${fmt(p.cutterDiameter)}`);
    if (p.x1 <= p.x0 || p.y1 <= p.y0) em.warnings.push("X1/Y1 must be greater than X0/Y0.");
    if (p.totalDepth <= 0 || p.depthPerPass <= 0) em.warnings.push("Depths must be positive.");
    const step = Math.max(0.5, p.cutterDiameter * (p.stepoverPct / 100));
    const alongX = p.direction === "x";
    const [a0, a1, b0, b1] = alongX ? [p.x0, p.x1, p.y0, p.y1] : [p.y0, p.y1, p.x0, p.x1];
    const start = a0 - p.overhang;
    const end = a1 + p.overhang;
    // Evenly spread rows: the actual stepover is the requested one or slightly less, and the last row can
    // never coincide with the one before it (which is what put two cuts on the same line).
    const rows = spread(b0, b1, step);
    const zPasses = Math.max(1, Math.ceil(p.totalDepth / p.depthPerPass));
    const clearance = p.topZ + 2;
    const pt = (a: number, b: number): Point => (alongX ? { x: a, y: b } : { x: b, y: a });
    for (let zi = 1; zi <= zPasses; zi += 1) {
      const z = Math.max(p.topZ - p.totalDepth, p.topZ - zi * p.depthPerPass);
      em.comment(`Z pass ${zi} of ${zPasses} at Z${fmt(z)}: ${rows.length} rows ${fmt(rows.length > 1 ? Math.abs(rows[1]! - rows[0]!) : 0)} mm apart`);
      let forward = true;
      for (const [ri, b] of rows.entries()) {
        const from = forward ? start : end;
        const to = forward ? end : start;
        if (ri === 0 || p.pattern === "oneway") {
          em.rapid({ z: clearance });
          em.rapid(pt(from, b));
          em.line({ z }, p.plungeFeed);
        } else em.line(pt(from, b), p.feed); // zigzag: step over at depth
        em.line(pt(to, b), p.feed);
        if (p.pattern === "zigzag") forward = !forward;
      }
      em.rapid({ z: clearance });
    }
    return { name: `surface-${fmt(p.x1 - p.x0)}x${fmt(p.y1 - p.y0)}`, lines: em.finish(), warnings: em.warnings };
  }

  /* ------------------------------------------------------- top-down preview */
  interface Seg {
    from: Point;
    to: Point;
    rapid: boolean;
    /** Z at the middle of the segment: a top view alone cannot show a helix, so the drawing shades by depth. */
    z: number;
    /** Distance along the dominant axis, for the side elevation. */
    a: number;
  }
  /** Interprets the generator's own output (absolute XY, IJ arcs) into flat segments for the canvas. */
  function toSegments(lines: string[]): Seg[] {
    const segs: Seg[] = [];
    let x = 0;
    let y = 0;
    let z = 0;
    for (const raw of lines) {
      const code = raw.replace(/\([^)]*\)/g, "").trim().toUpperCase();
      if (!code) continue;
      const g = /^G([0123])\b/.exec(code)?.[1];
      if (!g) continue;
      const word = (w: string): number | undefined => {
        const m = new RegExp(`\\b${w}(-?\\d*\\.?\\d+)`).exec(code);
        return m ? Number(m[1]) : undefined;
      };
      const nx = word("X") ?? x;
      const ny = word("Y") ?? y;
      const nz = word("Z") ?? z;
      if (g === "2" || g === "3") {
        const i = word("I") ?? 0;
        const j = word("J") ?? 0;
        const cx = x + i;
        const cy = y + j;
        const r = Math.hypot(i, j);
        let a0 = Math.atan2(y - cy, x - cx);
        let a1 = Math.atan2(ny - cy, nx - cx);
        const cw = g === "2";
        if (Math.abs(nx - x) < 1e-6 && Math.abs(ny - y) < 1e-6) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI);
        else if (cw && a1 >= a0) a1 -= 2 * Math.PI;
        else if (!cw && a1 <= a0) a1 += 2 * Math.PI;
        const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
        let px = x;
        let py = y;
        let pz = z;
        for (let s = 1; s <= steps; s += 1) {
          const a = a0 + ((a1 - a0) * s) / steps;
          const qx = cx + r * Math.cos(a);
          const qy = cy + r * Math.sin(a);
          const qz = z + ((nz - z) * s) / steps; // helical arcs carry a Z word
          segs.push({ from: { x: px, y: py }, to: { x: qx, y: qy }, rapid: false, z: (pz + qz) / 2, a: qx });
          px = qx;
          py = qy;
          pz = qz;
        }
      } else if (nx !== x || ny !== y || nz !== z) segs.push({ from: { x, y }, to: { x: nx, y: ny }, rapid: g === "0", z: (z + nz) / 2, a: nx });
      x = nx;
      y = ny;
      z = nz;
    }
    return segs;
  }
  /**
   * Two views, because a helix seen from above is just a circle: the top view shades cutting moves by depth
   * (pale at the surface, dark at the deepest cut) and the elevation below plots the same moves against Z, so
   * a thread's turns, a hole's ramp and a facing pass's step-downs are all visible. Rapids are dashed grey.
   */
  function Preview({ lines }: { lines: string[] }): React.JSX.Element {
    const top = React.useRef<HTMLCanvasElement>(null);
    const side = React.useRef<HTMLCanvasElement>(null);
    React.useEffect(() => {
      const segs = toSegments(lines);
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      const rapidColour = dark ? "#777" : "#bbb";
      const bounds = (values: number[]): [number, number] => [Math.min(...values), Math.max(...values)];
      const prepare = (canvas: HTMLCanvasElement | null, w: number, h: number): CanvasRenderingContext2D | null => {
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return null;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.font = "10px system-ui";
        ctx.lineWidth = 1;
        return ctx;
      };
      const label = (ctx: CanvasRenderingContext2D, text: string, y: number): void => {
        ctx.setLineDash([]);
        ctx.fillStyle = dark ? "#aaa" : "#666";
        ctx.fillText(text, 6, y);
      };

      /* ---------------------------------------------------------------- top view */
      const topCtx = prepare(top.current, 300, 300);
      const cutting = segs.filter((seg) => !seg.rapid);
      const [zMin, zMax] = cutting.length ? bounds(cutting.map((seg) => seg.z)) : [0, 0];
      /** Pale near the top of the cut, dark at the deepest point; one colour when everything is at one Z. */
      const depthColour = (z: number): string => {
        const t = zMax - zMin > 1e-6 ? (zMax - z) / (zMax - zMin) : 0;
        const light = dark ? 70 - t * 35 : 62 - t * 38;
        return `hsl(${dark ? 145 : 176} 55% ${light}%)`;
      };
      if (topCtx && segs.length) {
        const [minX, maxX] = bounds(segs.flatMap((seg) => [seg.from.x, seg.to.x]));
        const [minY, maxY] = bounds(segs.flatMap((seg) => [seg.from.y, seg.to.y]));
        const span = Math.max(maxX - minX, maxY - minY, 1);
        const scale = 270 / span;
        const ox = 15 + (270 - (maxX - minX) * scale) / 2;
        const oy = 15 + (270 - (maxY - minY) * scale) / 2;
        const tx = (v: number): number => ox + (v - minX) * scale;
        const ty = (v: number): number => 300 - (oy + (v - minY) * scale);
        topCtx.setLineDash([3, 3]);
        topCtx.strokeStyle = rapidColour;
        topCtx.beginPath();
        for (const seg of segs) {
          if (!seg.rapid) continue;
          topCtx.moveTo(tx(seg.from.x), ty(seg.from.y));
          topCtx.lineTo(tx(seg.to.x), ty(seg.to.y));
        }
        topCtx.stroke();
        topCtx.setLineDash([]);
        // Deepest last, so the floor of a pocket reads on top of the passes that got there.
        for (const seg of [...cutting].sort((a, b) => b.z - a.z)) {
          topCtx.strokeStyle = depthColour(seg.z);
          topCtx.beginPath();
          topCtx.moveTo(tx(seg.from.x), ty(seg.from.y));
          topCtx.lineTo(tx(seg.to.x), ty(seg.to.y));
          topCtx.stroke();
        }
        label(topCtx, `top · X ${fmt(minX)} … ${fmt(maxX)}   Y ${fmt(minY)} … ${fmt(maxY)}`, 294);
      }

      /* --------------------------------------------------------------- elevation */
      const sideCtx = prepare(side.current, 300, 120);
      if (sideCtx && segs.length) {
        const [minA, maxA] = bounds(segs.flatMap((seg) => [seg.from.x, seg.to.x]));
        const [minZ, maxZ] = bounds(segs.flatMap((seg) => [seg.z]));
        const sx = 280 / Math.max(1e-6, maxA - minA || 1);
        const sz = 78 / Math.max(1e-6, maxZ - minZ || 1);
        const ax = (v: number): number => 10 + (v - minA) * sx;
        const az = (v: number): number => 96 - (v - minZ) * sz;
        for (const rapid of [true, false]) {
          sideCtx.setLineDash(rapid ? [3, 3] : []);
          sideCtx.strokeStyle = rapid ? rapidColour : dark ? "#4ade80" : "#0f766e";
          sideCtx.beginPath();
          for (const seg of segs) {
            if (seg.rapid !== rapid) continue;
            sideCtx.moveTo(ax(seg.from.x), az(seg.z));
            sideCtx.lineTo(ax(seg.to.x), az(seg.z));
          }
          sideCtx.stroke();
        }
        label(sideCtx, `front · Z ${fmt(minZ)} … ${fmt(maxZ)}`, 114);
      }
    }, [lines]);
    return (
      <div>
        <canvas ref={top} className="usermod-cyc-canvas" width={300} height={300} />
        <canvas ref={side} className="usermod-cyc-canvas usermod-cyc-side" width={300} height={120} />
      </div>
    );
  }

  /* --------------------------------------------------------------- the form */
  type Tab = "thread" | "hole" | "surface";
  type Values = Record<string, string>;
  interface FieldDef {
    key: string;
    label: string;
    help?: string;
    kind?: "number" | "text" | "toggle" | "select";
    options?: Usermod.SelectOption[];
  }
  const COMMON_FIELDS: FieldDef[] = [
    { key: "cutterDiameter", label: "Cutter Ø (mm)" },
    { key: "feed", label: "Feed (mm/min)" },
    { key: "plungeFeed", label: "Plunge feed (mm/min)" },
    { key: "rpm", label: "Spindle (rpm)" },
    { key: "safeZ", label: "Safe Z (mm)", help: "Rapid height above the work" },
    { key: "coolant", label: "Coolant / air (M8)", kind: "toggle" }
  ];
  const FIELDS: Record<Tab, FieldDef[]> = {
    thread: [
      { key: "kind", label: "Thread", kind: "select", options: [{ value: "internal", label: "Internal (hole)" }, { value: "external", label: "External (stud)" }] },
      { key: "hand", label: "Hand", kind: "select", options: [{ value: "right", label: "Right-hand" }, { value: "left", label: "Left-hand" }] },
      { key: "cut", label: "Milling", kind: "select", options: [{ value: "climb", label: "Climb" }, { value: "conventional", label: "Conventional" }] },
      { key: "majorDiameter", label: "Major Ø (mm)", help: "M8 = 8" },
      { key: "pitch", label: "Pitch (mm)", help: "M8 coarse = 1.25" },
      { key: "length", label: "Thread length (mm)" },
      { key: "passes", label: "Radial passes" },
      { key: "topZ", label: "Thread top Z (mm)" },
      { key: "centers", label: "Positions X,Y; …", kind: "text", help: "e.g. 0,0; 20,0" },
      { key: "springPass", label: "Spring pass at full depth", kind: "toggle" },
      { key: "preMill", label: "Pre-mill hole to minor Ø (internal)", kind: "toggle" },
      { key: "preMillPitch", label: "Pre-mill pitch (mm/rev)" },
      ...COMMON_FIELDS
    ],
    hole: [
      { key: "diameter", label: "Hole Ø (mm)" },
      { key: "depth", label: "Depth (mm)" },
      { key: "pitch", label: "Pitch (mm per rev)" },
      { key: "stepoverPct", label: "Radial stepover (% of Ø)" },
      { key: "topZ", label: "Top Z (mm)" },
      { key: "centers", label: "Positions X,Y; …", kind: "text", help: "e.g. 0,0; 50,0" },
      { key: "finishPass", label: "Finish pass", kind: "toggle" },
      { key: "finishAllowance", label: "Finish allowance (mm)" },
      { key: "climb", label: "Climb (G3 inside)", kind: "toggle" },
      ...COMMON_FIELDS
    ],
    surface: [
      { key: "x0", label: "X0 (mm)" },
      { key: "y0", label: "Y0 (mm)" },
      { key: "x1", label: "X1 (mm)" },
      { key: "y1", label: "Y1 (mm)" },
      { key: "stepoverPct", label: "Stepover (% of Ø)" },
      { key: "depthPerPass", label: "Depth per pass (mm)" },
      { key: "totalDepth", label: "Total depth (mm)" },
      { key: "topZ", label: "Top Z (mm)" },
      { key: "overhang", label: "Overhang past edges (mm)" },
      { key: "direction", label: "Direction", kind: "select", options: [{ value: "x", label: "Along X" }, { value: "y", label: "Along Y" }] },
      { key: "pattern", label: "Pattern", kind: "select", options: [{ value: "zigzag", label: "Zigzag" }, { value: "oneway", label: "One way (climb)" }] },
      ...COMMON_FIELDS
    ]
  };
  const DEFAULTS: Record<Tab, Values> = {
    thread: { kind: "internal", hand: "right", cut: "climb", majorDiameter: "8", pitch: "1.25", length: "10", passes: "3", topZ: "0", centers: "0,0", springPass: "true", preMill: "false", preMillPitch: "0.5", cutterDiameter: "6", feed: "600", plungeFeed: "300", rpm: "12000", safeZ: "5", coolant: "false" },
    hole: { diameter: "12", depth: "10", pitch: "0.5", stepoverPct: "40", topZ: "0", centers: "0,0", finishPass: "true", finishAllowance: "0.1", climb: "true", cutterDiameter: "6", feed: "800", plungeFeed: "300", rpm: "12000", safeZ: "5", coolant: "false" },
    surface: { x0: "0", y0: "0", x1: "200", y1: "150", stepoverPct: "45", depthPerPass: "0.5", totalDepth: "0.5", topZ: "0", overhang: "12", direction: "x", pattern: "zigzag", cutterDiameter: "22", feed: "2500", plungeFeed: "500", rpm: "14000", safeZ: "5", coolant: "false" }
  };
  const parseCenters = (text: string): Point[] =>
    text
      .split(/[;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((pair) => {
        const [x, y] = pair.split(/[\s,]+/).map((v) => Number(v));
        return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
      });
  const common = (v: Values): Common => ({ safeZ: num(v.safeZ ?? "5", 5), rpm: num(v.rpm ?? "12000", 12000), feed: num(v.feed ?? "600", 600), plungeFeed: num(v.plungeFeed ?? "300", 300), coolant: v.coolant === "true" });
  function generate(tab: Tab, v: Values): Program {
    const c = common(v);
    const n = (k: string): number => num(v[k] ?? "0");
    switch (tab) {
      case "thread":
        return generateThread({
          ...c,
          kind: v.kind === "external" ? "external" : "internal",
          hand: v.hand === "left" ? "left" : "right",
          cut: v.cut === "conventional" ? "conventional" : "climb",
          majorDiameter: n("majorDiameter"),
          pitch: n("pitch"),
          length: n("length"),
          cutterDiameter: n("cutterDiameter"),
          passes: n("passes"),
          springPass: v.springPass === "true",
          topZ: n("topZ"),
          centers: parseCenters(v.centers ?? ""),
          preMill: v.preMill === "true",
          preMillPitch: Math.max(0.1, n("preMillPitch"))
        });
      case "hole":
        return generateHole({
          ...c,
          diameter: n("diameter"),
          depth: n("depth"),
          cutterDiameter: n("cutterDiameter"),
          pitch: Math.max(0.05, n("pitch")),
          stepoverPct: Math.min(90, Math.max(5, n("stepoverPct"))),
          finishPass: v.finishPass === "true",
          finishAllowance: Math.max(0, n("finishAllowance")),
          climb: v.climb !== "false",
          topZ: n("topZ"),
          centers: parseCenters(v.centers ?? "")
        });
      default:
        return generateSurface({
          ...c,
          x0: n("x0"),
          y0: n("y0"),
          x1: n("x1"),
          y1: n("y1"),
          cutterDiameter: n("cutterDiameter"),
          stepoverPct: Math.min(95, Math.max(5, n("stepoverPct"))),
          depthPerPass: n("depthPerPass"),
          totalDepth: n("totalDepth"),
          topZ: n("topZ"),
          direction: v.direction === "y" ? "y" : "x",
          pattern: v.pattern === "oneway" ? "oneway" : "zigzag",
          overhang: Math.max(0, n("overhang"))
        });
    }
  }
  const isValues = (raw: unknown): raw is Values => typeof raw === "object" && raw !== null && Object.values(raw).every((x) => typeof x === "string");

  function Dialog({ initialTab }: { initialTab: Tab }): React.JSX.Element {
    const [tab, setTab] = React.useState<Tab>(initialTab);
    const [values, setValues] = React.useState<Record<Tab, Values>>({ ...DEFAULTS });
    const [program, setProgram] = React.useState<Program | null>(null);
    const [result, setResult] = React.useState<{ tone: "good" | "bad" | "neutral"; text: string; detail?: string } | null>(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
      void window.usermod.info().then((r) => {
        if (!r.ok) return;
        const saved = r.data.config.settings["cycles"] ?? {};
        setValues((prev) => {
          const next = { ...prev };
          for (const t of ["thread", "hole", "surface"] as Tab[]) {
            const raw = saved[t];
            if (isValues(raw)) next[t] = { ...DEFAULTS[t], ...raw };
          }
          return next;
        });
      });
    }, []);
    const v = values[tab];
    const set = (key: string, value: string): void => setValues((prev) => ({ ...prev, [tab]: { ...prev[tab], [key]: value } }));
    const run = (): void => {
      const p = generate(tab, v);
      setProgram(p);
      setResult(null);
      void window.usermod.setSettings("cycles", { ...values }).catch(() => undefined);
    };
    const withBusy = (fn: () => Promise<void>) => async (): Promise<void> => {
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
      }
    };
    const text = program ? program.lines.join("\n") : "";
    const validate = withBusy(async () => {
      if (!program) return;
      const r = await window.api.gcode.validate(text, []);
      if (!r.ok) throw new Error(r.message || r.code || "validation failed");
      const tokens = r.data.result.tokens ?? [];
      const errors = tokens.filter((t) => t.level === "error");
      setResult({ tone: errors.length ? "bad" : "good", text: errors.length ? `${errors.length} error(s), ${tokens.length - errors.length} note(s)` : `No errors. ${tokens.length} note(s).`, detail: tokens.slice(0, 60).map((t) => `L${t.line} ${t.level} ${t.code} ${t.value ?? ""}  ${t.msg ?? ""}`).join("\n") || undefined });
    });
    const estimate = withBusy(async () => {
      if (!program) return;
      const r = await window.api.gcode.estimatedTime(text);
      if (!r.ok) throw new Error(r.message || r.code || "estimate failed");
      const t = r.data.motionTime;
      setResult({ tone: "neutral", text: `Estimated motion time: ${typeof t === "number" ? rt.formatDuration(t) : JSON.stringify(t)}` });
    });
    const exportFile = withBusy(async () => {
      if (!program) return;
      const dialog = await window.api.dialog.showSave({ defaultPath: `${program.name}.nc`, filters: [{ name: "G-code", extensions: ["nc", "gcode", "tap"] }] });
      if (!dialog.ok || !dialog.data.filePath || dialog.data.canceled) return;
      const w = await window.api.store.writeFile(dialog.data.filePath, text); // the loader's export hook applies the post-processor chain
      if (!w.ok) throw new Error(w.message || w.code || "write failed");
      rt.toast(`Exported ${dialog.data.filePath}`, { kind: "success", duration: 5000 });
    });
    const copy = async (): Promise<void> => {
      await navigator.clipboard.writeText(text);
      rt.toast("Program copied", { kind: "success" });
    };
    const field = (f: FieldDef): React.ReactNode => {
      const value = v[f.key] ?? "";
      switch (f.kind) {
        case "toggle":
          return <Toggle key={f.key} label={f.label} checked={value === "true"} onChange={(on) => set(f.key, on ? "true" : "false")} help={f.help} />;
        case "select":
          return <Select key={f.key} label={f.label} options={f.options ?? []} value={value} onChange={(x) => set(f.key, x)} help={f.help} />;
        case "text":
          return <Input key={f.key} label={f.label} value={value} onChange={(x) => set(f.key, x)} help={f.help} />;
        default:
          return <Input key={f.key} type="number" label={f.label} value={value} onChange={(x) => set(f.key, x)} help={f.help} step={0.01} />;
      }
    };
    const summary: [string, React.ReactNode][] = program
      ? [
          ["Program", program.name],
          ["Lines", String(program.lines.length)],
          ["Warnings", program.warnings.length ? <span className="usermod-err">{program.warnings.length}</span> : "none"]
        ]
      : [];
    return (
      <>
        <div className="usermod-cyc-tabs">
          {(["thread", "hole", "surface"] as Tab[]).map((t) => (
            <button key={t} type="button" className="usermod-btn" data-active={t === tab} onClick={() => setTab(t)}>
              {t === "thread" ? "Thread milling" : t === "hole" ? "Helical hole" : "Surfacing"}
            </button>
          ))}
        </div>
        <Sub>
          {tab === "thread"
            ? "Single-form thread mill, helical G2/G3 one pitch per revolution, bottom-up. Positions are the thread axis in work coordinates. Right-hand internal climb = G3."
            : tab === "hole"
              ? "Helical interpolation with a plain end mill; roughing radii from the centre outwards, then a finish pass at the final diameter."
              : "Raster facing across a rectangle in work coordinates; the cutter overhangs the edges by the overhang value."}
        </Sub>
        <div className="usermod-cyc-grid">{FIELDS[tab].map(field)}</div>
        <Row>
          <Button label="Generate" primary onClick={run} />
          <Button label="Validate" disabled={!program || busy} onClick={validate} />
          <Button label="Estimate time" disabled={!program || busy} onClick={estimate} />
          <Button label="Copy" disabled={!program} onClick={copy} />
          <Button label="Export via post-processors…" disabled={!program || busy} onClick={exportFile} />
        </Row>
        {program ? (
          <>
            {program.warnings.length ? <Err>{program.warnings.map((w, i) => <div key={i}>{w}</div>)}</Err> : null}
            {result ? (
              <div className={result.tone === "bad" ? "usermod-err" : result.tone === "good" ? "usermod-ok" : undefined} style={{ marginTop: 6 }}>
                {result.text}
                {result.detail ? <Mono>{result.detail}</Mono> : null}
              </div>
            ) : null}
            <div className="usermod-cyc-out">
              <div>
                <KV pairs={summary} />
                <Mono>{text}</Mono>
              </div>
              <Preview lines={program.lines} />
            </div>
          </>
        ) : null}
        <Section title="Notes">
          <Sub>Programs are absolute (G90), metric (G21), XY plane (G17). Full-circle arcs use I/J centre offsets. Run a new program above the part first, or with the spindle off, and check the machine's travel limits.</Sub>
        </Section>
      </>
    );
  }

  function open(tab: Tab = "thread"): void {
    ui.react.modal("Cycles", <Dialog initialTab={tab} />, { width: 900 });
  }
  ui.toolbar.addButton({ id: "cycles", title: "Cycles", icon: () => ui.icons.svg("M9 2h6v3H9V2zm0 5h6v3H9V7zm0 5h6v3H9v-3zm0 5h6v2l-3 3-3-3v-2z"), order: 15, onClick: () => open() });
})();
