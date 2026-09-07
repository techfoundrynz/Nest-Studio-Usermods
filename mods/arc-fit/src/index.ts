/*
 * Arc fit on export: runs Nest Studio's bundled ArcWelder on every exported program, replacing chains
 * of short G1 segments with G2/G3 arcs within the given tolerance. Relief carvings shrink a lot.
 * Nest Studio offers the same conversion manually; this makes it automatic.
 *
 * mods.json settings ("arc-fit"):
 *   resolutionMm          max path deviation in mm                 (default 0.01, the app's own value)
 *   pathTolerancePercent  ArcWelder --path-tolerance-percent       (default 0.05)
 *   maxRadiusMm           ArcWelder --max-radius-mm                (default 9999)
 *   allow3dArcs           ArcWelder --allow-3d-arcs                (default false)
 *   minBytes              skip programs smaller than this          (default 2048)
 *   exePath               override the ArcWelder executable        (default <resources>/ArcWelder.exe)
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface Settings {
  resolutionMm: number;
  pathTolerancePercent: number;
  maxRadiusMm: number;
  allow3dArcs: boolean;
  minBytes: number;
  exePath: string;
}

function defaultExePath(): string | null {
  const override = process.env.NEST_ARCWELDER;
  if (override) return override;
  // Electron's process augmentation types resourcesPath; under plain Node (tests) it is undefined at runtime.
  const resources: string | undefined = process.resourcesPath;
  if (!resources) return null;
  return path.join(resources, process.platform === "win32" ? "ArcWelder.exe" : "ArcWelder");
}

function run(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve();
    });
  });
}

/** Same clean-up the app applies to ArcWelder output: drop ';' comment lines and empty lines. */
const sanitize = (raw: string): string =>
  raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(";") && line.length !== 0)
    .join("\n") + "\n";

const mod: Usermod.Postprocessor<Settings> = {
  name: "arc-fit",
  description: "Runs the bundled ArcWelder on every export to turn G1 segment chains into G2/G3 arcs",
  stages: ["export"],
  async process(gcode, ctx) {
    const s: Settings = {
      resolutionMm: Number(ctx.settings.resolutionMm) || 0.01,
      pathTolerancePercent: Number(ctx.settings.pathTolerancePercent) || 0.05,
      maxRadiusMm: Number(ctx.settings.maxRadiusMm) || 9999,
      allow3dArcs: ctx.settings.allow3dArcs === true,
      minBytes: Number(ctx.settings.minBytes ?? 2048),
      exePath: typeof ctx.settings.exePath === "string" && ctx.settings.exePath ? ctx.settings.exePath : defaultExePath() ?? ""
    };
    if (gcode.length < s.minBytes) return undefined;
    if (!s.exePath || !fs.existsSync(s.exePath)) {
      ctx.warn(`ArcWelder not found (${s.exePath || "no path"}); skipping`);
      return undefined;
    }
    const workDir = path.join(ctx.dataDir, "arc-fit");
    fs.mkdirSync(workDir, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}`;
    const input = path.join(workDir, `in-${stamp}.nc`);
    const output = path.join(workDir, `out-${stamp}.nc`);
    try {
      fs.writeFileSync(input, gcode, "utf8");
      const args = [input, output, `-r=${s.resolutionMm}`, `-t=${s.pathTolerancePercent}`, `-m=${s.maxRadiusMm}`, "-p=NONE", "-l=ERROR"];
      if (s.allow3dArcs) args.push("-z");
      await run(s.exePath, args);
      const fitted = sanitize(fs.readFileSync(output, "utf8"));
      const before = gcode.split("\n").length;
      const after = fitted.split("\n").length;
      ctx.log(`${ctx.fileName ?? "program"}: ${before} -> ${after} lines (${(gcode.length / 1024).toFixed(0)} KB -> ${(fitted.length / 1024).toFixed(0)} KB)`);
      return fitted;
    } finally {
      for (const f of [input, output]) fs.rmSync(f, { force: true });
    }
  }
};

export = mod;
