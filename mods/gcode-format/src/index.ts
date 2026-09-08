/*
 * G-code format: whole-program text formatting for controllers with small storage or line-number expectations.
 * Both features are off until switched on in the settings; enabling the mod alone changes nothing.
 *
 *   stripComments   remove ( ) and ; comments (the leading comment block is kept by default because Nest Studio
 *                   reads its own JSON header from it) and, optionally, blank lines
 *   lineNumbers     prefix every code line with an N word, replacing any existing N word
 *
 * mods.json settings ("gcode-format"):
 *   stripComments (false), keepHeader (true), removeBlankLines (true)
 *   lineNumbers (false), start (10), step (10), skipComments (true)
 */
interface Settings {
  stripComments: boolean;
  keepHeader: boolean;
  removeBlankLines: boolean;
  lineNumbers: boolean;
  start: number;
  step: number;
  skipComments: boolean;
}

function stripComments(lines: string[], s: Settings, log: (m: string) => void): string[] {
  let start = 0;
  if (s.keepHeader) while (start < lines.length && /^\s*(\(|;|$)/.test(lines[start]!)) start += 1;
  const out = lines.slice(0, start);
  let removed = 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").trimEnd();
    if (!line.trim() && s.removeBlankLines) {
      removed += 1;
      continue;
    }
    out.push(line);
  }
  log(`stripped comments; removed ${removed} empty line(s)`);
  return out;
}
function numberLines(lines: string[], s: Settings, log: (m: string) => void): string[] {
  let n = Number(s.start) || 10;
  const step = Number(s.step) || 10;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (s.skipComments && /^(\(|;)/.test(trimmed)) return line;
    const numbered = `N${n} ${trimmed.replace(/^N\d+\s*/i, "")}`;
    n += step;
    return numbered;
  });
  log(`numbered lines up to N${n - step}`);
  return out;
}

const mod: Usermod.Postprocessor<Settings> = {
  name: "gcode-format",
  description: "Strips comments / blank lines and adds N line numbers, each only when switched on in its settings",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = { stripComments: false, keepHeader: true, removeBlankLines: true, lineNumbers: false, start: 10, step: 10, skipComments: true, ...ctx.settings };
    if (!s.stripComments && !s.lineNumbers) return undefined;
    let lines = gcode.split(/\r?\n/);
    if (s.stripComments) lines = stripComments(lines, s, ctx.log);
    if (s.lineNumbers) lines = numberLines(lines, s, ctx.log);
    return lines.join("\n") + (gcode.endsWith("\n") && !lines[lines.length - 1]?.length ? "" : "\n");
  }
};

export = mod;
