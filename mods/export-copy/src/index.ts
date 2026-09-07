/*
 * Export copy: after the other post-processors have run (the "z-" prefix sorts it last), also save
 * a copy of every exported program into a folder of your choice, for example a USB stick or a
 * network share the machine PC reads from. Does nothing until targetDir is set.
 *
 * mods.json settings ("export-copy"):
 *   targetDir        folder to copy into, e.g. "E:\\CNC" or "\\\\shopserver\\cnc" (default "" = off)
 *   subfolderByDate  put copies in YYYY-MM-DD subfolders                          (default false)
 *   overwrite        replace an existing file with the same name                  (default true)
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Settings {
  targetDir: string;
  subfolderByDate: boolean;
  overwrite: boolean;
}

const mod: Usermod.Postprocessor<Settings> = {
  name: "export-copy",
  description: "Also writes each exported program to a configured folder (off until targetDir is set)",
  stages: ["export"],
  process(gcode, ctx) {
    const s: Settings = { targetDir: "", subfolderByDate: false, overwrite: true, ...ctx.settings };
    if (!s.targetDir || !ctx.fileName) return undefined;
    let dir = s.targetDir;
    if (s.subfolderByDate) dir = path.join(dir, new Date().toISOString().slice(0, 10));
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, path.basename(ctx.fileName));
      if (!s.overwrite && fs.existsSync(target)) {
        ctx.warn(`copy skipped, exists: ${target}`);
        return undefined;
      }
      fs.writeFileSync(target, gcode, "utf8");
      ctx.log(`copied to ${target}`);
    } catch (error) {
      ctx.warn(`copy to ${dir} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
};

export = mod;
