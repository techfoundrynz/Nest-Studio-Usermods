/*
 * Safe shutdown: makes sure the program switches the spindle and coolant off before it ends, and
 * that it ends at all. Only inserts what is missing; never removes or reorders existing code.
 *
 * mods.json settings ("safe-shutdown"):
 *   spindleOff   insert M5 before program end when the spindle was started and not stopped (default true)
 *   coolantOff   insert M9 before program end when M7/M8 was used and not cancelled       (default true)
 *   programEnd   append M30 when neither M30 nor M2 is present                              (default true)
 */
interface Settings {
  spindleOff: boolean;
  coolantOff: boolean;
  programEnd: boolean;
}
const code = (line: string): string => line.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();

const mod: Usermod.Postprocessor<Settings> = {
  name: "safe-shutdown",
  description: "Ensures M5/M9 before program end and a final M30 when missing",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = { spindleOff: true, coolantOff: true, programEnd: true, ...ctx.settings };
    const lines = gcode.split(/\r?\n/);
    let endIndex = -1;
    let spindleOn = false;
    let coolantOn = false;
    for (let i = 0; i < lines.length; i += 1) {
      const c = code(lines[i]!);
      if (!c.trim()) continue;
      if (/\bM0?[34]\b/.test(c)) spindleOn = true;
      if (/\bM0?5\b/.test(c)) spindleOn = false;
      if (/\bM0?[78]\b/.test(c)) coolantOn = true;
      if (/\bM0?9\b/.test(c)) coolantOn = false;
      if (/\bM30\b|\bM0?2\b/.test(c)) endIndex = i;
    }
    const inserts: string[] = [];
    if (s.spindleOff && spindleOn) inserts.push("M5 (usermod: spindle off)");
    if (s.coolantOff && coolantOn) inserts.push("M9 (usermod: coolant off)");
    if (!inserts.length && (endIndex >= 0 || !s.programEnd)) return undefined;

    if (endIndex >= 0) {
      lines.splice(endIndex, 0, ...inserts);
    } else {
      while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
      lines.push(...inserts, "M30 (usermod: program end)", "");
      ctx.warn(`${ctx.fileName ?? "program"} had no M30/M2; appended`);
    }
    if (inserts.length) ctx.log(`inserted ${inserts.map((l) => l.split(" ")[0]).join(", ")} before program end`);
    return lines.join("\n");
  }
};

export = mod;
