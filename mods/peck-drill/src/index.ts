/*
 * Peck drill: the CAM drills with one straight G1 plunge. For plunges deeper than minDepth this rewrites the
 * move into pecks (peckDepth each) with a retract between them so chips clear and the bit stays cool:
 *
 *   G1 Z-12 F200          →   G1 Z-3 F200 / G0 Z5 / G0 Z-2.5 / G1 Z-6 F200 / G0 Z5 / G0 Z-5.5 / … / G1 Z-12 F200
 *
 * A "drilling move" is a feed move that changes only Z (no X/Y/A) while in absolute mode. With onlyDrillMoves
 * (default) the next motion must also be a pure Z retract, so ramped or profile plunges are left alone.
 *
 * mods.json settings ("peck-drill"):
 *   peckDepth        depth per peck in mm                                        (default 3)
 *   minDepth         only plunges deeper than this are converted                 (default 4)
 *   retract          "full" (back to the plunge start Z) or "partial"            (default "full")
 *   partialRetract   retract distance for "partial" in mm                        (default 1)
 *   clearance        after a full retract, rapid back to this far above the previous depth (default 0.5)
 *   dwellSeconds     G4 dwell at the top of each retract, 0 = none               (default 0)
 *   onlyDrillMoves   require a pure Z retract after the plunge                    (default true)
 */
interface Settings {
  peckDepth: number;
  minDepth: number;
  retract: "full" | "partial";
  partialRetract: number;
  clearance: number;
  dwellSeconds: number;
  onlyDrillMoves: boolean;
}
const strip = (line: string): string => line.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").trim().toUpperCase();
const word = (code: string, letter: string): number | undefined => {
  const m = new RegExp(`(?:^|[^A-Z])${letter}(-?\\d*\\.?\\d+)`).exec(code);
  return m ? Number(m[1]) : undefined;
};
const fmt = (n: number): string => {
  const s = n.toFixed(3);
  return s.replace(/0+$/, "").replace(/\.$/, "");
};
interface Move {
  motion: number | null;
  x?: number;
  y?: number;
  z?: number;
  a?: number;
  f?: number;
  hasIJ: boolean;
}
function parseMove(code: string, modalMotion: number | null): Move | null {
  if (!code || /^[$%]/.test(code)) return null;
  const g = /(?:^|[^A-Z])G0?([0-3])(?![0-9.])/.exec(code);
  const explicit = g ? Number(g[1]) : null;
  const move: Move = { motion: explicit ?? modalMotion, x: word(code, "X"), y: word(code, "Y"), z: word(code, "Z"), a: word(code, "A"), f: word(code, "F"), hasIJ: word(code, "I") !== undefined || word(code, "J") !== undefined };
  // Non-motion G codes on the same line (G4, G10, G28, G53, G92…) mean this is not a plain move.
  if (/(?:^|[^A-Z])G(?:0?4|10|28|30|53|92)(?![0-9.])/.test(code)) return null;
  const hasAxis = move.x !== undefined || move.y !== undefined || move.z !== undefined || move.a !== undefined;
  return hasAxis || explicit !== null ? move : null;
}

const mod: Usermod.Postprocessor<Settings> = {
  name: "peck-drill",
  description: "Deep straight plunges become peck-drilling cycles with chip-clearing retracts",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = { peckDepth: 3, minDepth: 4, retract: "full", partialRetract: 1, clearance: 0.5, dwellSeconds: 0, onlyDrillMoves: true, ...ctx.settings };
    if (!(s.peckDepth > 0.1)) return undefined;
    const lines = gcode.split(/\r?\n/);
    const codes = lines.map(strip);
    const out: string[] = [];
    let modal: number | null = null;
    let relative = false;
    let z: number | null = null;
    let feed: number | undefined;
    let converted = 0;
    let pecks = 0;

    const nextMotion = (from: number): Move | null => {
      for (let j = from; j < codes.length; j += 1) {
        const c = codes[j]!;
        if (!c) continue;
        if (/(?:^|[^A-Z])G9[01](?![0-9.])/.test(c) || /(?:^|[^A-Z])M0?[0-9]+/.test(c) && !/(?:^|[^A-Z])G/.test(c) && !/[XYZA]-?\d/.test(c)) continue;
        const m = parseMove(c, modal);
        if (m) return m;
      }
      return null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const code = codes[i]!;
      if (/(?:^|[^A-Z])G91(?![0-9.])/.test(code)) relative = true;
      if (/(?:^|[^A-Z])G90(?![0-9.])/.test(code)) relative = false;
      const modalFeed = word(code, "F"); // a bare F word sets the modal feed for later plunges
      if (modalFeed !== undefined) feed = modalFeed;
      const move = parseMove(code, modal);
      if (!move) {
        out.push(line);
        continue;
      }
      if (move.motion !== null) modal = move.motion;
      const pureZ = move.z !== undefined && move.x === undefined && move.y === undefined && move.a === undefined && !move.hasIJ;
      const isPlunge = !relative && pureZ && (move.motion === 1) && z !== null && move.z !== undefined && z - move.z > s.minDepth;
      if (isPlunge && z !== null && move.z !== undefined) {
        const target = move.z;
        const start = z;
        const next = s.onlyDrillMoves ? nextMotion(i + 1) : null;
        const retractsAfter = !s.onlyDrillMoves || (next !== null && next.z !== undefined && next.x === undefined && next.y === undefined && next.a === undefined && !next.hasIJ && next.z > target);
        if (retractsAfter) {
          const f = move.f ?? feed;
          const feedWord = f !== undefined ? ` F${fmt(f)}` : "";
          out.push(`(usermod peck-drill: ${fmt(start - target)} mm plunge in ${fmt(s.peckDepth)} mm pecks)`);
          let cur = start;
          let count = 0;
          while (cur - target > 1e-6) {
            const bottom = Math.max(target, cur - s.peckDepth);
            out.push(`G1 Z${fmt(bottom)}${feedWord}`);
            count += 1;
            if (bottom - target > 1e-6) {
              if (s.retract === "partial") out.push(`G0 Z${fmt(bottom + s.partialRetract)}`);
              else {
                out.push(`G0 Z${fmt(start)}`);
                if (s.dwellSeconds > 0) out.push(`G4 P${fmt(s.dwellSeconds)}`);
                out.push(`G0 Z${fmt(bottom + s.clearance)}`);
              }
            }
            cur = bottom;
          }
          // The last peck is a G1, so the modal motion state matches what the original line left behind.
          pecks += count;
          converted += 1;
          z = target;
          continue;
        }
      }
      if (move.z !== undefined) z = relative ? (z ?? 0) + move.z : move.z;
      out.push(line);
    }
    if (!converted) return undefined;
    ctx.log(`converted ${converted} plunge(s) into ${pecks} pecks`);
    return out.join("\n");
  }
};

export = mod;
