/*
 * Export report (post-processor, runs last): analyses the final G-code of every export and writes a JSON
 * report to data/reports (bounds, tools, feed/spindle ranges, line/byte counts, header info), keeping the
 * newest N. Never modifies the G-code. The UI part shows the latest report.
 *
 * mods.json settings ("export-report"): keep (default 50)
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Report {
  file: string;
  path: string;
  exportedAt: string;
  lines: number;
  bytes: number;
  comments: number;
  tools: number[];
  feed: [number, number] | null;
  spindleMax: number | null;
  bounds: Record<"X" | "Y" | "Z", [number, number] | null>;
  relativeMoves: boolean;
  programEnd: boolean;
  header: Record<string, unknown> | null;
  toolChanges: number;
}
const WORD = /([A-Z])([-+]?\d*\.?\d+)/g;
const isAxis = (l: string): l is "X" | "Y" | "Z" => l === "X" || l === "Y" || l === "Z";

function analyze(gcode: string, fileName: string, filePath: string): Report {
  const b: Record<"X" | "Y" | "Z", [number, number]> = { X: [Infinity, -Infinity], Y: [Infinity, -Infinity], Z: [Infinity, -Infinity] };
  const tools = new Set<number>();
  let fMin = Infinity, fMax = -Infinity, sMax = -Infinity, comments = 0, relative = false, end = false, changes = 0;
  let header: Record<string, unknown> | null = null;
  const lines = gcode.split(/\r?\n/);
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("(") || t.startsWith(";")) {
      comments += 1;
      if (!header && t.startsWith("({")) {
        try {
          header = JSON.parse(t.slice(1, t.lastIndexOf(")"))) as Record<string, unknown>;
        } catch {
          /* not the app header */
        }
      }
      continue;
    }
    const code = t.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();
    if (/\bG91\b/.test(code)) relative = true;
    if (/\bM30\b|\bM0?2\b/.test(code)) end = true;
    if (/\bM0?6\b/.test(code)) changes += 1;
    let m: RegExpExecArray | null;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(code))) {
      const letter = m[1]!;
      const n = Number(m[2]);
      if (letter === "T") tools.add(n);
      else if (letter === "F") {
        fMin = Math.min(fMin, n);
        fMax = Math.max(fMax, n);
      } else if (letter === "S") sMax = Math.max(sMax, n);
      else if (isAxis(letter) && !relative) {
        b[letter][0] = Math.min(b[letter][0], n);
        b[letter][1] = Math.max(b[letter][1], n);
      }
    }
  }
  const range = (r: [number, number]): [number, number] | null => (Number.isFinite(r[0]) ? r : null);
  return {
    file: fileName,
    path: filePath,
    exportedAt: new Date().toISOString(),
    lines: lines.length,
    bytes: gcode.length,
    comments,
    tools: [...tools].sort((a, c) => a - c),
    feed: Number.isFinite(fMin) ? [fMin, fMax] : null,
    spindleMax: Number.isFinite(sMax) ? sMax : null,
    bounds: { X: range(b.X), Y: range(b.Y), Z: range(b.Z) },
    relativeMoves: relative,
    programEnd: end,
    header,
    toolChanges: changes
  };
}

const mod: Usermod.Postprocessor<{ keep: number }> = {
  name: "export-report",
  description: "Writes a JSON stats report for every export to data/reports (never changes the G-code)",
  stages: ["export"],
  process(gcode, ctx) {
    const keep = Math.max(1, Number(ctx.settings.keep ?? 50));
    const dir = path.join(ctx.dataDir, "reports");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const report = analyze(gcode, ctx.fileName ?? "program.nc", ctx.filePath ?? "");
      const stamp = report.exportedAt.replace(/[:.]/g, "-").slice(0, 19);
      const file = path.join(dir, `${stamp}-${report.file.replace(/[^\w.-]+/g, "_")}.json`);
      fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
      fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(report, null, 2), "utf8");
      for (const old of fs.readdirSync(dir).filter((f) => f !== "latest.json" && f.endsWith(".json")).sort().slice(0, -keep)) fs.rmSync(path.join(dir, old), { force: true });
      ctx.log(`report written: ${path.basename(file)}`);
    } catch (error) {
      ctx.warn(`report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
};

export = mod;
