/*
 * Tool-change guard: before every tool change (M6, or a bare Tn when treatTAsChange is on) make sure
 * the spindle and coolant are off, retract in machine coordinates, and optionally pause (M0) so a
 * bit can be swapped by hand. Only inserts what is not already there. Restores G91 if the program was
 * in relative mode, because the retract line forces G90.
 *
 * mods.json settings ("tool-change", shared with the UI half):
 *   spindleOff      insert M5 if the spindle is running                   (default true)
 *   coolantOff      insert M9 if coolant is on                            (default true)
 *   retract         insert retractGcode                                   (default true)
 *   retractGcode    machine-coordinate retract line                       (default "G53 G90 G0 Z-1", the app's own)
 *   pause           insert M0 so the operator can change the bit          (default false: machines with a magazine change tools themselves)
 *   skipFirst       do not guard the first tool change of the program     (default true)
 *   treatTAsChange  treat a line with only Tn (no M6) as a tool change    (default false)
 */
interface Settings {
  spindleOff: boolean;
  coolantOff: boolean;
  retract: boolean;
  retractGcode: string;
  pause: boolean;
  skipFirst: boolean;
  treatTAsChange: boolean;
}
const code = (line: string): string => line.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();

const mod: Usermod.Postprocessor<Settings> = {
  name: "tool-change",
  description: "Safe retract, spindle/coolant off and optional M0 pause before every tool change",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = {
      spindleOff: true,
      coolantOff: true,
      retract: true,
      retractGcode: "G53 G90 G0 Z-1",
      pause: false,
      skipFirst: true,
      treatTAsChange: false,
      ...ctx.settings
    };
    const lines = gcode.split(/\r?\n/);
    const out: string[] = [];
    let spindleOn = false;
    let coolantOn = false;
    let relative = false;
    let changes = 0;
    let guarded = 0;
    const recent = (): string[] => out.slice(-4).map(code);

    for (const line of lines) {
      const c = code(line);
      const isChange = /\bM0?6\b/.test(c) || (s.treatTAsChange && /^\s*T\d+\s*$/.test(c));
      if (isChange) {
        changes += 1;
        if (!(s.skipFirst && changes === 1)) {
          const tool = /\bT(\d+)/.exec(c)?.[1];
          const inserts: string[] = [`(usermod: tool change${tool ? ` T${tool}` : ""})`];
          const seen = recent();
          if (s.spindleOff && spindleOn && !seen.some((l) => /\bM0?5\b/.test(l))) inserts.push("M5");
          if (s.coolantOff && coolantOn && !seen.some((l) => /\bM0?9\b/.test(l))) inserts.push("M9");
          if (s.retract && s.retractGcode && !seen.some((l) => /\bG53\b/.test(l) && /\bZ/.test(l))) {
            inserts.push(s.retractGcode);
            if (relative) inserts.push("G91 (usermod: restore relative mode)");
          }
          if (s.pause) inserts.push(`M0 (usermod: change tool${tool ? ` to T${tool}` : ""}, then resume)`);
          out.push(...inserts);
          guarded += 1;
          spindleOn = false;
          if (s.coolantOff) coolantOn = false;
        }
      }
      if (/\bM0?[34]\b/.test(c)) spindleOn = true;
      if (/\bM0?5\b/.test(c)) spindleOn = false;
      if (/\bM0?[78]\b/.test(c)) coolantOn = true;
      if (/\bM0?9\b/.test(c)) coolantOn = false;
      if (/\bG91\b/.test(c)) relative = true;
      if (/\bG90\b/.test(c)) relative = false;
      out.push(line);
    }
    if (!guarded) return undefined;
    ctx.log(`guarded ${guarded} of ${changes} tool change(s)${s.pause ? " with M0 pause" : ""}`);
    return out.join("\n");
  }
};

export = mod;
