/*
 * Program header: inserts an informative comment block after Nest Studio's own header lines.
 * Includes file name, export time, line count, tools used, feed/spindle ranges and XYZ bounds.
 *
 * mods.json settings ("program-header"):
 *   label        text on the first line                  (default "Nest Studio usermod")
 *   includeStats scan the program for tools/feeds/bounds (default true; skipped above maxStatBytes)
 *   maxStatBytes largest file to scan for stats          (default 50 MB)
 */
interface Settings {
  label: string;
  includeStats: boolean;
  maxStatBytes: number;
}
type Range = [min: number, max: number];
interface Scan {
  lines: number;
  tools: Set<number>;
  fMin: number;
  fMax: number;
  sMax: number;
  bounds: Record<"X" | "Y" | "Z", Range>;
  relative: boolean;
}

const WORD = /([A-Z])([-+]?\d*\.?\d+)/g;
const isAxis = (letter: string): letter is "X" | "Y" | "Z" => letter === "X" || letter === "Y" || letter === "Z";

function scan(text: string): Scan {
  const s: Scan = {
    lines: 0,
    tools: new Set(),
    fMin: Infinity,
    fMax: -Infinity,
    sMax: -Infinity,
    bounds: { X: [Infinity, -Infinity], Y: [Infinity, -Infinity], Z: [Infinity, -Infinity] },
    relative: false
  };
  for (const raw of text.split(/\r?\n/)) {
    s.lines += 1;
    const t = raw.trim();
    if (!t || t.startsWith("(") || t.startsWith(";")) continue;
    const code = t.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();
    if (/\bG91\b/.test(code)) s.relative = true;
    let m: RegExpExecArray | null;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(code))) {
      const letter = m[1]!;
      const n = Number(m[2]);
      if (letter === "T") s.tools.add(n);
      else if (letter === "F") {
        if (n < s.fMin) s.fMin = n;
        if (n > s.fMax) s.fMax = n;
      } else if (letter === "S") {
        if (n > s.sMax) s.sMax = n;
      } else if (isAxis(letter) && !s.relative) {
        const range = s.bounds[letter];
        if (n < range[0]) range[0] = n;
        if (n > range[1]) range[1] = n;
      }
    }
  }
  return s;
}
const fmtRange = (lo: number, hi: number): string => (Number.isFinite(lo) ? `${lo} to ${hi}` : "n/a");
const fmtBound = (r: Range): string => (Number.isFinite(r[0]) ? `${r[0].toFixed(3)}..${r[1].toFixed(3)}` : "n/a");
const clean = (s: string): string => s.replace(/[()]/g, "");

const mod: Usermod.Postprocessor<Settings> = {
  name: "program-header",
  description: "Adds file name, date, tools, feed/spindle and bounds as comments after the app header",
  stages: ["export"],
  process(gcode, ctx) {
    const label = ctx.settings.label || "Nest Studio usermod";
    const includeStats = ctx.settings.includeStats !== false;
    const maxStatBytes = Number(ctx.settings.maxStatBytes) || 50 * 1024 * 1024;
    const lines = gcode.split(/\r?\n/);
    let index = 0;
    while (index < lines.length && /^\s*(\(|;|$)/.test(lines[index]!)) index += 1;

    const header = [`(--- ${clean(label)} ---)`, `(File: ${clean(ctx.fileName ?? "unknown")})`, `(Exported: ${new Date().toLocaleString()})`];
    if (includeStats && gcode.length <= maxStatBytes) {
      const s = scan(gcode);
      header.push(`(Lines: ${s.lines}  Size: ${(gcode.length / 1024).toFixed(1)} KB)`);
      header.push(`(Tools: ${s.tools.size ? [...s.tools].sort((a, b) => a - b).map((t) => `T${t}`).join(" ") : "none"})`);
      header.push(`(Feed: ${fmtRange(s.fMin, s.fMax)}  Spindle max: ${Number.isFinite(s.sMax) ? s.sMax : "n/a"})`);
      header.push(`(Bounds X ${fmtBound(s.bounds.X)}  Y ${fmtBound(s.bounds.Y)}  Z ${fmtBound(s.bounds.Z)}${s.relative ? "  G91 present: partial" : ""})`);
    } else if (includeStats) {
      header.push(`(Lines: ${lines.length}  Size: ${(gcode.length / 1024 / 1024).toFixed(1)} MB  stats skipped: large file)`);
    }
    header.push("(--- end usermod header ---)");
    lines.splice(index, 0, ...header);
    ctx.log(`header inserted at line ${index + 1} (${header.length} lines)`);
    return lines.join("\n");
  }
};

export = mod;
