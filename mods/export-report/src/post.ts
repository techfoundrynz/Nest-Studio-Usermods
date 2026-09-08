/*
 * Export report (post-processor, runs last): analyses the final G-code of every export and writes a JSON report
 * to data/reports (bounds, tools, feed/spindle ranges, line/byte counts, header info), keeping the newest N, and
 * runs the depth checks that used to be the depth-guard mod:
 *   - cutting below the stock: Z below -(stockThickness + allowanceBelow); the thickness comes from the setting
 *     or from the app's header comment ({"stockSize": "..."}) when useHeaderStock is on
 *   - low rapids: a G0 that moves in X/Y while Z is below safeZ
 *   - envelope: X or Y outside [xMin, xMax] / [yMin, yMax] when those are set
 * Never modifies the G-code. The UI half shows the latest report and warns when a check failed.
 *
 * mods.json settings ("export-report"): keep (50), stockThickness (mm or null), useHeaderStock (true),
 *   allowanceBelow (0.5), safeZ (2), checkRapids (true), xMin/xMax/yMin/yMax (null = off)
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Settings {
  keep: number;
  stockThickness: number | null;
  useHeaderStock: boolean;
  allowanceBelow: number;
  safeZ: number;
  checkRapids: boolean;
  xMin: number | null;
  xMax: number | null;
  yMin: number | null;
  yMax: number | null;
}
interface Issue {
  kind: "below-stock" | "low-rapid" | "envelope";
  message: string;
  count: number;
  firstLine: number;
  worst: number;
}
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
  stockThickness: number | null;
  issues: Issue[];
}
const WORD = /([A-Z])([-+]?\d*\.?\d+)/g;
const isAxis = (l: string): l is "X" | "Y" | "Z" => l === "X" || l === "Y" || l === "Z";
const word = (code: string, letter: string): number | undefined => {
  const m = new RegExp(`(?:^|[^A-Z])${letter}(-?\\d*\\.?\\d+)`).exec(code);
  return m ? Number(m[1]) : undefined;
};

/** Stock thickness from the app's header: an explicit thickness key, or the smallest number in stockSize. */
function headerThickness(header: Record<string, unknown> | null): number | null {
  if (!header) return null;
  const thick = header.stockThickness ?? header.thickness;
  if (typeof thick === "number" && thick > 0) return thick;
  if (typeof header.stockSize === "string") {
    const nums = header.stockSize.match(/\d+(?:\.\d+)?/g)?.map(Number).filter((n) => n > 0) ?? [];
    if (nums.length >= 3) return Math.min(...nums);
  }
  return null;
}

function analyze(gcode: string, fileName: string, filePath: string, s: Settings): Report {
  const b: Record<"X" | "Y" | "Z", [number, number]> = { X: [Infinity, -Infinity], Y: [Infinity, -Infinity], Z: [Infinity, -Infinity] };
  const tools = new Set<number>();
  let fMin = Infinity;
  let fMax = -Infinity;
  let sMax = -Infinity;
  let comments = 0;
  let relative = false;
  let end = false;
  let changes = 0;
  let header: Record<string, unknown> | null = null;
  const lines = gcode.split(/\r?\n/);
  // First pass: header (needed for the stock thickness) and stats.
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
  // Second pass: depth / rapid / envelope checks on absolute moves.
  const thickness = s.stockThickness ?? (s.useHeaderStock ? headerThickness(header) : null);
  const floor = thickness !== null ? -(thickness + s.allowanceBelow) : null;
  const issues = new Map<Issue["kind"], Issue>();
  const add = (kind: Issue["kind"], message: string, line: number, value: number, worse: (a: number, c: number) => boolean): void => {
    const cur = issues.get(kind);
    if (!cur) issues.set(kind, { kind, message, count: 1, firstLine: line, worst: value });
    else {
      cur.count += 1;
      if (worse(value, cur.worst)) cur.worst = value;
    }
  };
  let rel = false;
  let modal: number | null = null;
  let x: number | null = null;
  let y: number | null = null;
  let z: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const code = lines[i]!.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").trim().toUpperCase();
    if (!code) continue;
    if (/(?:^|[^A-Z])G91(?![0-9.])/.test(code)) rel = true;
    if (/(?:^|[^A-Z])G90(?![0-9.])/.test(code)) rel = false;
    if (/(?:^|[^A-Z])G(?:53|28|30|92|10)(?![0-9.])/.test(code)) continue;
    const g = /(?:^|[^A-Z])G0?([0-3])(?![0-9.])/.exec(code);
    if (g) modal = Number(g[1]);
    const nx = word(code, "X");
    const ny = word(code, "Y");
    const nz = word(code, "Z");
    if (nx === undefined && ny === undefined && nz === undefined) continue;
    if (rel) {
      x = nx !== undefined ? (x ?? 0) + nx : x;
      y = ny !== undefined ? (y ?? 0) + ny : y;
      z = nz !== undefined ? (z ?? 0) + nz : z;
      continue;
    }
    const movedXY = (nx !== undefined && nx !== x) || (ny !== undefined && ny !== y);
    x = nx ?? x;
    y = ny ?? y;
    z = nz ?? z;
    const line = i + 1;
    if (floor !== null && z !== null && z < floor) add("below-stock", `Cuts below the stock bottom (Z < ${floor.toFixed(2)} with ${thickness} mm stock + ${s.allowanceBelow} mm allowance)`, line, z, (a, c) => a < c);
    if (s.checkRapids && modal === 0 && movedXY && z !== null && z < s.safeZ) add("low-rapid", `Rapid (G0) moves in X/Y while Z is below the safe height ${s.safeZ} mm`, line, z, (a, c) => a < c);
    if (x !== null && ((s.xMin !== null && x < s.xMin) || (s.xMax !== null && x > s.xMax))) add("envelope", `X outside [${s.xMin ?? "-∞"}, ${s.xMax ?? "∞"}]`, line, x, (a, c) => Math.abs(a) > Math.abs(c));
    if (y !== null && ((s.yMin !== null && y < s.yMin) || (s.yMax !== null && y > s.yMax))) add("envelope", `Y outside [${s.yMin ?? "-∞"}, ${s.yMax ?? "∞"}]`, line, y, (a, c) => Math.abs(a) > Math.abs(c));
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
    toolChanges: changes,
    stockThickness: thickness,
    issues: [...issues.values()]
  };
}

const mod: Usermod.Postprocessor<Settings> = {
  name: "export-report",
  description: "JSON stats report per export plus depth, low-rapid and envelope checks (never changes the G-code)",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = { keep: 50, stockThickness: null, useHeaderStock: true, allowanceBelow: 0.5, safeZ: 2, checkRapids: true, xMin: null, xMax: null, yMin: null, yMax: null, ...ctx.settings };
    const keep = Math.max(1, Number(s.keep) || 50);
    const dir = path.join(ctx.dataDir, "reports");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const report = analyze(gcode, ctx.fileName ?? "program.nc", ctx.filePath ?? "", s);
      const stamp = report.exportedAt.replace(/[:.]/g, "-").slice(0, 19);
      const file = path.join(dir, `${stamp}-${report.file.replace(/[^\w.-]+/g, "_")}.json`);
      fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
      fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(report, null, 2), "utf8");
      for (const old of fs.readdirSync(dir).filter((f) => f !== "latest.json" && f.endsWith(".json")).sort().slice(0, -keep)) fs.rmSync(path.join(dir, old), { force: true });
      if (report.issues.length) ctx.warn(`${report.file}: ${report.issues.map((i) => `${i.kind} x${i.count} (first at line ${i.firstLine}, worst ${i.worst.toFixed(2)})`).join("; ")}`);
      else ctx.log(`report written: ${path.basename(file)} (clean${report.stockThickness !== null ? `, stock ${report.stockThickness} mm` : ", stock thickness unknown"})`);
    } catch (error) {
      ctx.warn(`report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
};

export = mod;
