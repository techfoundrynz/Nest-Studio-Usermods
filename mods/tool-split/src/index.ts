/*
 * Tool split: on a machine without a tool changer a multi-tool program means stopping mid-job to swap bits.
 * This writes one extra file per tool section next to the exported program (part-T1.nc, part-T2.nc, …),
 * each starting with the program's own preamble (header comments, G21/G90 setup) and ending with a safe
 * footer (spindle and coolant off, retract, M30). The main export is unchanged apart from an index comment.
 * Runs late (order 95) so every other post-processor has already shaped the program.
 *
 * mods.json settings ("tool-split"):
 *   suffix          file name suffix, {tool} = T-number, {n} = section number     (default "-{tool}")
 *   minSections     only split programs with at least this many tool sections     (default 2)
 *   retractGcode    footer retract line                                            (default "G53 G90 G0 Z-1")
 *   indexComment    add a comment listing the part files to the main export       (default true)
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Settings {
  suffix: string;
  minSections: number;
  retractGcode: string;
  indexComment: boolean;
}
const strip = (line: string): string => line.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").trim().toUpperCase();
const isChange = (code: string): boolean => /(?:^|[^A-Z])M0?6(?![0-9.])/.test(code);
const isMotion = (code: string): boolean => /(?:^|[^A-Z])G0?[0-3](?![0-9.])/.test(code) || /[XYZA]-?\d/.test(code);

const mod: Usermod.Postprocessor<Settings> = {
  name: "tool-split",
  description: "One extra program file per tool next to each multi-tool export",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = { suffix: "-{tool}", minSections: 2, retractGcode: "G53 G90 G0 Z-1", indexComment: true, ...ctx.settings };
    if (!ctx.filePath) return undefined;
    const lines = gcode.split(/\r?\n/);
    const changes: number[] = [];
    for (let i = 0; i < lines.length; i += 1) if (isChange(strip(lines[i]!))) changes.push(i);
    if (changes.length < s.minSections) return undefined;
    const dir = path.dirname(ctx.filePath);
    if (!fs.existsSync(dir)) {
      ctx.warn(`target folder does not exist, not splitting: ${dir}`);
      return undefined;
    }
    // Preamble: everything before the first tool change that is not a motion (header comments, units, plane…).
    const preamble = lines.slice(0, changes[0]).filter((l) => !isMotion(strip(l)));
    // Footer of the whole program (from the last M30/M2 backwards through M5/M9/retract lines) is dropped from
    // the last section and replaced by the common footer, so every part file ends the same way.
    let end = lines.length;
    while (end > 0 && strip(lines[end - 1]!) === "") end -= 1;
    const tail = strip(lines[end - 1] ?? "");
    if (/(?:^|[^A-Z])M0?(?:30|2)(?![0-9.])/.test(tail)) {
      end -= 1;
      while (end > 0 && /^(M0?5|M0?9|G53\b.*|G0 ?Z.*)$/.test(strip(lines[end - 1]!))) end -= 1;
    }
    const ext = path.extname(ctx.filePath);
    const base = path.basename(ctx.filePath, ext);
    const written: string[] = [];
    for (let n = 0; n < changes.length; n += 1) {
      const from = changes[n]!;
      const to = n + 1 < changes.length ? changes[n + 1]! : end;
      const section = lines.slice(from, to);
      const tool = /(?:^|[^A-Z])T(\d+)/.exec(strip(lines[from]!))?.[1] ?? (n > 0 ? /(?:^|[^A-Z])T(\d+)/.exec(strip(lines[from - 1] ?? ""))?.[1] : undefined);
      const label = tool ? `T${tool}` : `S${n + 1}`;
      const name = `${base}${s.suffix.replace("{tool}", label).replace("{n}", String(n + 1))}${ext}`;
      const body = [
        ...preamble,
        `(usermod tool-split: part ${n + 1} of ${changes.length}, ${label}, from ${base}${ext})`,
        ...section.filter((l, idx) => idx === 0 || !/(?:^|[^A-Z])M0?(?:30|2)(?![0-9.])/.test(strip(l))),
        "M5 (usermod tool-split footer)",
        "M9",
        s.retractGcode,
        "M30",
        ""
      ];
      try {
        fs.writeFileSync(path.join(dir, name), body.join("\n"), "utf8");
        written.push(name);
      } catch (error) {
        ctx.warn(`could not write ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!written.length) return undefined;
    ctx.log(`wrote ${written.length} part file(s): ${written.join(", ")}`);
    if (!s.indexComment) return undefined;
    // Index comment goes after the app header block (leading comment lines), keeping the header first.
    let insertAt = 0;
    while (insertAt < lines.length && /^\s*\(/.test(lines[insertAt]!)) insertAt += 1;
    const out = lines.slice();
    out.splice(insertAt, 0, `(usermod tool-split: per-tool files ${written.join(", ")})`);
    return out.join("\n");
  }
};

export = mod;
