import { unzipSync } from "fflate";
import C = require("clipper-lib");
import { parseArtwork, boolean, boardIslands, extrude, MAX_INPUT } from "./geometry";

export const MAX_ZIP = 16 * 1024 * 1024;
type Role = "outline" | "top" | "bottom" | "drill" | "mask" | "paste" | "silkscreen" | "other";
export interface BundleSummary { files: { name: string; role: Role }[]; top: boolean; bottom: boolean; outlines: number; drills: number }
export interface BundleOptions { thicknessMm: number; engraveDepthMm: number; toleranceMm: number; sides?: "top" | "bottom" | "both"; includeDrills?: boolean }

function role(name: string, text: string): Role {
  const ext = name.split(".").pop()!.toLowerCase();
  if (/^g(?:ko|m1|ml)$/.test(ext) || /%TF\.FileFunction,Profile[,\*]/i.test(text) || /(?:edge[._ -]?cuts|boardoutline|profile)\.(?:gbr|ger)$/i.test(name)) return "outline";
  if (ext === "gtl" || /%TF\.FileFunction,Copper,[^*]*,Top/i.test(text)) return "top";
  if (ext === "gbl" || /%TF\.FileFunction,Copper,[^*]*,Bot/i.test(text)) return "bottom";
  if (["drl", "xln"].includes(ext)) return "drill";
  if (["gts", "gbs"].includes(ext) || /%TF\.FileFunction,Soldermask,/i.test(text)) return "mask";
  if (["gtp", "gbp"].includes(ext) || /%TF\.FileFunction,Paste,/i.test(text)) return "paste";
  if (["gto", "gbo"].includes(ext) || /%TF\.FileFunction,Legend,/i.test(text)) return "silkscreen";
  return "other";
}

function readBundle(bytes: Uint8Array): { name: string; role: Role; text: string }[] {
  if (bytes.byteLength > MAX_ZIP) throw new Error("Gerber ZIP exceeds 16 MiB.");
  let total = 0, entries = 0;
  const names: string[] = [], seen = new Set<string>();
  const files = unzipSync(bytes, { filter(entry) {
    if (++entries > 512) throw new Error("Gerber ZIP contains more than 512 entries.");
    if (entry.name.endsWith("/")) return false;
    const identity = entry.name.replace(/\\/g, "/").toLowerCase();
    if (seen.has(identity)) throw new Error("ZIP contains duplicate file names.");
    seen.add(identity); names.push(entry.name);
    if (!/\.(?:g[a-z0-9]{2,5}|drl|xln)$/i.test(entry.name)) return false;
    total += entry.originalSize;
    if (total > 64 * 1024 * 1024 || entry.originalSize > MAX_INPUT) throw new Error("ZIP exceeds the 8 MiB per-file or 64 MiB expanded size limit.");
    return true;
  } });
  return names.map(name => {
    const text = files[name] ? Buffer.from(files[name]!).toString("utf8") : "";
    return { name, text, role: role(name, text) };
  });
}

export function inspectBundle(bytes: Uint8Array): BundleSummary | null {
  const files = readBundle(bytes);
  if (!files.some(f => ["top", "bottom", "outline"].includes(f.role))) return null;
  return { files: files.map(({ name, role }) => ({ name, role })), top: files.some(f => f.role === "top"), bottom: files.some(f => f.role === "bottom"), outlines: files.filter(f => f.role === "outline").length, drills: files.filter(f => f.role === "drill").length };
}

export async function convertBundle(bytes: Uint8Array, options: BundleOptions): Promise<Buffer[]> {
  const { thicknessMm: height, engraveDepthMm: depth, toleranceMm: tolerance, sides = "both", includeDrills = true } = options;
  if (!Number.isFinite(height) || height < 0.01 || height > 100 || !Number.isFinite(depth) || depth <= 0 || depth >= height) throw new Error("Invalid board thickness or engraving depth.");
  if (!["top", "bottom", "both"].includes(sides)) throw new Error("Invalid copper side selection.");
  const files = readBundle(bytes);
  const one = (r: Role) => {
    const selected = files.filter(f => f.role === r);
    if (selected.length > 1) throw new Error(`Multiple ${r} layers found. ZIP one related fabrication set at a time.`);
    return selected[0];
  };
  const outline = one("outline"), top = one("top"), bottom = one("bottom");
  if (!outline) throw new Error("Gerber ZIP needs a closed board-outline layer (.GKO or X2 Profile). No board size will be guessed.");
  if ((!top && !bottom) || (sides === "top" && !top) || (sides === "bottom" && !bottom)) throw new Error("Selected copper layer is missing from the ZIP.");
  const usedTop = sides !== "bottom" && top, usedBottom = sides !== "top" && bottom;
  if (usedTop && usedBottom && depth * 2 >= height) throw new Error("Engraving both sides must leave a solid core; reduce depth below half the board thickness.");
  // A shared micrometre grid keeps all source coordinate systems registered, including inch layers.
  const grid = 1e6;
  const parse = async (file: typeof outline, kind: "gerber" | "outline" | "drill"): Promise<C.Paths> => {
    if (!file) return [];
    try {
      const parsed = await parseArtwork(file.text, tolerance, kind);
      return parsed.paths.map(p => p.map(v => ({ X: Math.round(v.X * parsed.scale * grid), Y: Math.round(v.Y * parsed.scale * grid) })));
    } catch (error) { throw new Error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const profile = await parse(outline, "outline");
  const islands = boardIslands(profile);
  if (!islands.length) throw new Error("The outline layer contains no closed board profiles.");
  const topPaths = usedTop ? await parse(usedTop, "gerber") : null;
  const bottomPaths = usedBottom ? await parse(usedBottom, "gerber") : undefined;
  let drills: C.Paths = [];
  if (includeDrills) for (const file of files.filter(f => f.role === "drill")) drills = boolean(drills, await parse(file, "drill"));
  let triangles = 0;
  return islands.map(island => {
    const board = boolean(island, drills, C.ClipType.ctDifference);
    if (!board.length) throw new Error("Drill geometry removes an entire board; check the drill units.");
    const stl = extrude(topPaths ?? board, 1 / grid, height, depth, board, bottomPaths, Boolean(usedTop));
    triangles += stl.readUInt32LE(80);
    if (triangles > 1_000_000) throw new Error("Converted boards exceed one million triangles in total.");
    return stl;
  });
}
