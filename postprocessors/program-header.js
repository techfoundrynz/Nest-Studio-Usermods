/*
 * Program header: inserts an informative comment block after Nest Studio's own header lines.
 * Includes file name, export time, line count, tools used, feed/spindle ranges and XYZ bounds.
 *
 * mods.json settings ("program-header"):
 *   label        text on the first line              (default "Nest Studio usermod")
 *   includeStats scan the program for tools/feeds/bounds (default true; skipped above maxStatBytes)
 *   maxStatBytes largest file to scan for stats      (default 50 MB)
 */
const WORD = /([A-Z])([-+]?\d*\.?\d+)/g;

function scan(text) {
  const tools = new Set();
  let fMin = Infinity, fMax = -Infinity, sMax = -Infinity;
  const b = { X: [Infinity, -Infinity], Y: [Infinity, -Infinity], Z: [Infinity, -Infinity] };
  let relative = false;
  let lines = 0;
  for (const raw of text.split(/\r?\n/)) {
    lines += 1;
    const t = raw.trim();
    if (!t || t.startsWith("(") || t.startsWith(";")) continue;
    const code = t.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();
    if (/\bG91\b/.test(code)) relative = true;
    let m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(code))) {
      const n = Number(m[2]);
      switch (m[1]) {
        case "T": tools.add(Number(m[2])); break;
        case "F": if (n < fMin) fMin = n; if (n > fMax) fMax = n; break;
        case "S": if (n > sMax) sMax = n; break;
        case "X": case "Y": case "Z":
          if (!relative) {
            if (n < b[m[1]][0]) b[m[1]][0] = n;
            if (n > b[m[1]][1]) b[m[1]][1] = n;
          }
          break;
        default:
      }
    }
  }
  return { lines, tools, fMin, fMax, sMax, b, relative };
}
const fmtRange = (lo, hi) => (Number.isFinite(lo) ? `${lo} to ${hi}` : "n/a");
const fmtBound = (r) => (Number.isFinite(r[0]) ? `${r[0].toFixed(3)}..${r[1].toFixed(3)}` : "n/a");
const clean = (s) => String(s).replace(/[()]/g, "");

module.exports = {
  name: "program-header",
  description: "Adds file name, date, tools, feed/spindle and bounds as comments after the app header",
  stages: ["export"],
  process(gcode, ctx) {
    const label = ctx.settings.label || "Nest Studio usermod";
    const includeStats = ctx.settings.includeStats !== false;
    const maxStatBytes = Number(ctx.settings.maxStatBytes) || 50 * 1024 * 1024;
    const lines = gcode.split(/\r?\n/);
    let index = 0;
    while (index < lines.length && /^\s*(\(|;|$)/.test(lines[index])) index += 1;

    const header = [`(--- ${clean(label)} ---)`, `(File: ${clean(ctx.fileName ?? "unknown")})`, `(Exported: ${new Date().toLocaleString()})`];
    if (includeStats && gcode.length <= maxStatBytes) {
      const s = scan(gcode);
      header.push(`(Lines: ${s.lines}  Size: ${(gcode.length / 1024).toFixed(1)} KB)`);
      header.push(`(Tools: ${s.tools.size ? [...s.tools].sort((a, c) => a - c).map((t) => `T${t}`).join(" ") : "none"})`);
      header.push(`(Feed: ${fmtRange(s.fMin, s.fMax)}  Spindle max: ${Number.isFinite(s.sMax) ? s.sMax : "n/a"})`);
      header.push(`(Bounds X ${fmtBound(s.b.X)}  Y ${fmtBound(s.b.Y)}  Z ${fmtBound(s.b.Z)}${s.relative ? "  G91 present: partial" : ""})`);
    } else if (includeStats) {
      header.push(`(Lines: ${lines.length}  Size: ${(gcode.length / 1024 / 1024).toFixed(1)} MB  stats skipped: large file)`);
    }
    header.push("(--- end usermod header ---)");
    lines.splice(index, 0, ...header);
    ctx.log(`header inserted at line ${index + 1} (${header.length} lines)`);
    return lines.join("\n");
  }
};
