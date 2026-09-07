/*
 * Strip comments (disabled by default: remove the leading underscore to enable).
 * Removes ( ) and ; comments and blank lines to shrink programs for controllers with small storage.
 * Keeps the leading comment block by default because Nest Studio reads its own JSON header from it.
 *
 * mods.json settings ("strip-comments"):
 *   keepHeader        keep the leading comment block (default true)
 *   removeBlankLines  drop empty lines               (default true)
 */
interface Settings {
  keepHeader: boolean;
  removeBlankLines: boolean;
}

const mod: Usermod.Postprocessor<Settings> = {
  name: "strip-comments",
  description: "Removes comments and blank lines (keeps the app header block)",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = { keepHeader: true, removeBlankLines: true, ...ctx.settings };
    const lines = gcode.split(/\r?\n/);
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
    ctx.log(`stripped comments; removed ${removed} empty line(s)`);
    return out.join("\n") + "\n";
  }
};

export = mod;
