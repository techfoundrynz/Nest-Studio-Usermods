/*
 * Line numbers (disabled by default: remove the leading underscore to enable).
 * Prefixes each code line with an N word, replacing any existing N words.
 *
 * mods.json settings ("line-numbers"):
 *   start         first number                          (default 10)
 *   step          increment                             (default 10)
 *   skipComments  leave comment-only lines unnumbered   (default true)
 */
interface Settings {
  start: number;
  step: number;
  skipComments: boolean;
}

const mod: Usermod.Postprocessor<Settings> = {
  name: "line-numbers",
  description: "Adds N line numbers to code lines",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = { start: 10, step: 10, skipComments: true, ...ctx.settings };
    let n = Number(s.start) || 10;
    const step = Number(s.step) || 10;
    const out = gcode.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (s.skipComments && /^(\(|;)/.test(trimmed)) return line;
      const numbered = `N${n} ${trimmed.replace(/^N\d+\s*/i, "")}`;
      n += step;
      return numbered;
    });
    ctx.log(`numbered lines up to N${n - step}`);
    return out.join("\n");
  }
};

export = mod;
