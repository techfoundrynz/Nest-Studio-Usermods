import C = require("clipper-lib");
import earcut = require("earcut");
import parser = require("gerber-parser");
import plotter = require("gerber-plotter");
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";

type XY = [number, number];
type Primitive =
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "rect"; cx: number; cy: number; r: number; width: number; height: number }
  | { type: "poly"; points: XY[] }
  | { type: "ring"; cx: number; cy: number; r: number; width: number }
  | { type: "clip"; shape: Primitive[]; clip: Primitive }
  | { type: "layer"; polarity: "dark" | "clear" };
type Segment = { type: "line" | "arc"; start: number[]; end: number[]; center: XY; radius: number; sweep: number; dir: "cw" | "ccw" };
type Plot =
  | { type: "shape"; tool: string; shape: Primitive[] }
  | { type: "pad"; tool: string; x: number; y: number }
  | { type: "stroke"; width: number; path: Segment[] }
  | { type: "fill"; path: Segment[] }
  | { type: "polarity"; polarity: "dark" | "clear" }
  | { type: "repeat"; offsets: XY[] }
  | { type: "size"; units: "in" | "mm" };
export const MAX_INPUT = 8 * 1024 * 1024;
const SCALE = 1e6;
const MAX_POINTS = 500_000;

export function boolean(a: C.Paths, b: C.Paths, type = C.ClipType.ctUnion, evenOdd = false): C.Paths {
  const clip = new C.Clipper();
  clip.StrictlySimple = true;
  clip.AddPaths(a, C.PolyType.ptSubject, true);
  clip.AddPaths(b, C.PolyType.ptClip, true);
  const result: C.Paths = [];
  const fill = evenOdd ? C.PolyFillType.pftEvenOdd : C.PolyFillType.pftNonZero;
  clip.Execute(type, result, fill, fill);
  return result;
}

/** Plot in source units, compose ordered dark/clear layers, then extrude in millimetres. */
export async function convertGerber(text: string, thicknessMm = 1.6, toleranceMm = 0.01, engraveDepthMm?: number): Promise<Buffer> {
  return (await convertGerberBoards(text, thicknessMm, toleranceMm, engraveDepthMm, 0))[0]!;
}

/** Split at empty horizontal/vertical strips, never at individual disconnected copper pads. */
export function splitBoards(paths: C.Paths, scale: number, gapMm: number): C.Paths[] {
  if (gapMm === 0) return [paths];
  if (!Number.isFinite(gapMm) || gapMm < 2 || gapMm > 100) throw new Error("Board separation gap must be 2–100 mm, or zero to keep a panel together.");
  const bounds = paths.map(p => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of p) { x0 = Math.min(x0, v.X); x1 = Math.max(x1, v.X); y0 = Math.min(y0, v.Y); y1 = Math.max(y1, v.Y); }
    return { p, min: [x0, y0], max: [x1, y1] };
  });
  const output: C.Paths[] = [];
  const pending = [bounds];
  while (pending.length) {
    const items = pending.pop()!;
    let best = gapMm / scale, partition: [typeof bounds, typeof bounds] | undefined;
    for (let axis = 0; axis < 2; axis++) {
      const sorted = [...items].sort((a, b) => a.min[axis]! - b.min[axis]!);
      let end = sorted[0]?.max[axis] ?? 0;
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i]!.min[axis]! - end;
        if (gap >= best) { best = gap; partition = [sorted.slice(0, i), sorted.slice(i)]; }
        end = Math.max(end, sorted[i]!.max[axis]!);
      }
    }
    if (partition) pending.push(partition[1], partition[0]);
    else output.push(items.map(item => item.p));
  }
  return output;
}

export async function convertGerberBoards(text: string, thicknessMm = 1.6, toleranceMm = 0.01, engraveDepthMm?: number, splitGapMm = 2): Promise<Buffer[]> {
  if (!Number.isFinite(thicknessMm) || thicknessMm < 0.01 || thicknessMm > 100) throw new Error("Layer thickness must be 0.01–100 mm.");
  if (engraveDepthMm !== undefined && (!Number.isFinite(engraveDepthMm) || engraveDepthMm <= 0 || engraveDepthMm >= thicknessMm)) throw new Error("Engraving depth must be greater than zero and less than board thickness.");
  const { paths: image, scale } = await parseArtwork(text, toleranceMm);
  let triangles = 0;
  return splitBoards(image, scale, splitGapMm).map(board => {
    const bytes = extrude(board, scale, thicknessMm, engraveDepthMm);
    triangles += bytes.readUInt32LE(80);
    if (triangles > 1_000_000) throw new Error("Converted boards exceed one million triangles in total.");
    return bytes;
  });
}

export async function parseArtwork(text: string, toleranceMm = 0.01, kind: "gerber" | "outline" | "drill" = "gerber"): Promise<{ paths: C.Paths; scale: number }> {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_INPUT) throw new Error("Gerber file exceeds the 8 MiB limit.");
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0.001 || toleranceMm > 0.1) throw new Error("Curve tolerance must be 0.001–0.1 mm.");
  if (kind !== "drill" && (!/%FS[LT]A\d*X\d\dY\d\d\*%/.test(text) || !/%MO(MM|IN)\*%/.test(text) || !/M0?2\*/.test(text))) {
    throw new Error("Expected an RS-274X Gerber with explicit absolute coordinate format, units, and M02 end marker.");
  }
  if (kind === "drill" && (!/M48/.test(text) || !/(?:METRIC|INCH)/.test(text) || !/M(?:30|00)/.test(text))) throw new Error("Drill file requires an Excellon header, explicit units and an end marker.");
  if (kind === "drill" && /\bMETRIC\b/.test(text) && /\bINCH\b/.test(text)) throw new Error("Drill file changes units mid-file.");
  // These commands are not implemented by tracespace 4; never silently import a partial image.
  if (/%(?:AB|LM|LR|LS|IP|MI|OF|SF|AS|IR)/.test(text)) throw new Error("This Gerber uses unsupported aperture blocks, transforms, or legacy image commands. Export flattened RS-274X artwork.");
  // X2 file/aperture/object attributes carry metadata only; tracespace 4 warns on them.
  text = text.replace(/%T(?:F|A|O|D)[^%]*\*%/g, "");
  const units = /%MOIN\*%/.test(text) || (kind === "drill" && /\bINCH\b/.test(text)) ? 25.4 : 1;
  if (units === 25.4 && /%MOMM\*%/.test(text)) throw new Error("Gerber changes units mid-file.");
  const tolerance = toleranceMm / units;
  let pointCount = 0;
  const point = (x: number, y: number): C.Point => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.max(Math.abs(x), Math.abs(y)) * units > 100_000) throw new Error("Gerber coordinate is invalid or exceeds 100 metres.");
    if (++pointCount > MAX_POINTS) throw new Error("Gerber is too complex; simplify the layer or increase curve tolerance.");
    return { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  };
  const steps = (radius: number, sweep: number): number => {
    if (!(radius > 0) || !Number.isFinite(sweep)) throw new Error("Invalid Gerber arc.");
    return Math.max(2, Math.ceil(Math.abs(sweep) / Math.min(Math.PI / 8, 2 * Math.acos(Math.max(-1, 1 - tolerance / radius)))));
  };
  const circle = (x: number, y: number, r: number): C.Path => {
    const n = steps(r, 2 * Math.PI);
    if (n > MAX_POINTS) throw new Error("Gerber circle is too complex.");
    return Array.from({ length: n }, (_, i) => point(x + r * Math.cos(i * 2 * Math.PI / n), y + r * Math.sin(i * 2 * Math.PI / n)));
  };
  const shape = (primitives: Primitive[]): C.Paths => {
    let result: C.Paths = [];
    let clear = false;
    for (const p of primitives) {
      if (p.type === "layer") { clear = p.polarity === "clear"; continue; }
      let paths: C.Paths;
      if (p.type === "circle") paths = [circle(p.cx, p.cy, p.r)];
      else if (p.type === "poly") {
        const contour = p.points.map(([x, y]) => point(x, y));
        if (C.Clipper.Area(contour) < 0) contour.reverse();
        paths = [contour];
      } else if (p.type === "rect") {
        const { cx, cy, width: w, height: h } = p;
        const r = Math.min(p.r || 0, w / 2, h / 2);
        const contour: C.Path = [];
        for (let i = 0; i < 4; i++) {
          const x = cx + (i === 0 || i === 3 ? 1 : -1) * (w / 2 - r);
          const y = cy + (i < 2 ? 1 : -1) * (h / 2 - r);
          const n = r ? steps(r, Math.PI / 2) : 1;
          for (let j = 0; j <= n; j++) contour.push(point(x + r * Math.cos((i + j / n) * Math.PI / 2), y + r * Math.sin((i + j / n) * Math.PI / 2)));
        }
        paths = [contour];
      } else if (p.type === "ring") {
        paths = [circle(p.cx, p.cy, p.r + p.width / 2)];
        if (p.r > p.width / 2) paths.push(circle(p.cx, p.cy, p.r - p.width / 2).reverse());
      } else if (p.type === "clip") paths = boolean(shape(p.shape), shape([p.clip]), C.ClipType.ctIntersection);
      else throw new Error("Unsupported Gerber aperture primitive.");
      result = boolean(result, paths, clear ? C.ClipType.ctDifference : C.ClipType.ctUnion);
    }
    return result;
  };
  const contours = (segments: Segment[]): C.Paths => {
    const paths: C.Paths = [];
    let previous: number[] | undefined;
    let current: C.Path = [];
    for (const s of segments) {
      if (!previous || previous[0] !== s.start[0] || previous[1] !== s.start[1]) {
        current = [point(s.start[0]!, s.start[1]!)]; paths.push(current);
      }
      if (s.type === "arc") {
        const n = steps(s.radius, s.sweep);
        if (n > MAX_POINTS) throw new Error("Gerber arc is too complex.");
        const start = Math.atan2(s.start[1]! - s.center[1], s.start[0]! - s.center[0]);
        for (let i = 1; i < n; i++) {
          const angle = start + (s.dir === "cw" ? -1 : 1) * Math.abs(s.sweep) * i / n;
          current.push(point(s.center[0] + s.radius * Math.cos(angle), s.center[1] + s.radius * Math.sin(angle)));
        }
      } else if (s.type !== "line") throw new Error("Unsupported Gerber segment.");
      current.push(point(s.end[0]!, s.end[1]!)); previous = s.end;
    }
    return paths;
  };
  let image: C.Paths = [];
  const outlinePaths: C.Paths = [];
  let pending: C.Paths = [];
  let clear = false;
  let offsets: XY[] = [[0, 0]];
  const tools = new Map<string, C.Paths>();
  const flush = (): void => {
    image = boolean(image, pending, clear ? C.ClipType.ctDifference : C.ClipType.ctUnion);
    pending = [];
  };
  const parsed = parser({ filetype: kind === "drill" ? "drill" : "gerber" });
  const plotted = plotter();
  const warnings: string[] = [];
  for (const stream of [parsed, plotted]) stream.on("warning", (w: { message: string }) => warnings.push(w.message));
  await pipeline(Readable.from([text]), parsed, plotted, new Writable({ objectMode: true, write(raw: Plot, _encoding, done) {
    try {
      let paths: C.Paths = [];
      switch (raw.type) {
        case "shape": tools.set(raw.tool, shape(raw.shape)); break;
        case "pad": {
          if (kind === "outline") throw new Error("Outline layers must use closed paths or regions, not flashed apertures.");
          const tool = tools.get(raw.tool);
          if (!tool) throw new Error("Gerber references an undefined aperture.");
          paths = tool.map(p => p.map(v => point(v.X / SCALE + raw.x, v.Y / SCALE + raw.y))); break;
        }
        case "fill": paths = boolean(contours(raw.path), [], C.ClipType.ctUnion, true); break;
        case "stroke": {
          if (kind === "outline") {
            const rings = contours(raw.path);
            for (const [x, y] of offsets) outlinePaths.push(...rings.map(p => p.map(v => point(v.X / SCALE + x, v.Y / SCALE + y))));
            break;
          }
          if (!(raw.width > 0)) throw new Error("Gerber contains a zero-width track.");
          const offset = new C.ClipperOffset(2, tolerance * SCALE);
          for (const p of contours(raw.path)) offset.AddPath(p, C.JoinType.jtRound, C.EndType.etOpenRound);
          offset.Execute(paths, raw.width * SCALE / 2); break;
        }
        case "polarity": flush(); clear = raw.polarity === "clear"; break;
        case "repeat":
          flush();
          // Repeated blocks with clear exposures need block-order composition, not per-shape repetition.
          if (raw.offsets.length > 1 && /%LPC\*%/.test(text)) throw new Error("Step-repeat with clear polarity is not supported. Export flattened artwork.");
          offsets = raw.offsets.length ? raw.offsets : [[0, 0]];
          if (offsets.length > 1000) throw new Error("Too many Gerber repeats.");
          break;
        case "size": if (raw.units !== (units === 1 ? "mm" : "in")) throw new Error("Gerber changes units mid-file."); break;
        default: throw new Error("Unsupported Gerber plot command.");
      }
      for (const [x, y] of offsets) for (const p of paths) pending.push(p.map(v => point(v.X / SCALE + x, v.Y / SCALE + y)));
      done();
    } catch (error) { done(error as Error); }
  } }));
  if (warnings.length) throw new Error(`Gerber could not be imported reliably: ${warnings[0]}`);
  flush();
  if (kind === "outline" && outlinePaths.length) image = boolean(image, boolean(closeOutline(outlinePaths), [], C.ClipType.ctUnion, true));
  return { paths: image, scale: units / SCALE };
}

function closeOutline(paths: C.Paths): C.Paths {
  const key = (p: C.Point): string => `${p.X},${p.Y}`;
  const ends = new Map<string, number[]>();
  paths.forEach((p, i) => {
    for (const v of [p[0]!, p[p.length - 1]!]) { const k = key(v); ends.set(k, [...ends.get(k) ?? [], i]); }
  });
  if ([...ends.values()].some(ids => ids.length !== 2)) throw new Error("Board outline has open or branching contours. Export closed board outlines.");
  const used = new Set<number>(), rings: C.Paths = [];
  for (let i = 0; i < paths.length; i++) {
    if (used.has(i)) continue;
    const ring = [...paths[i]!]; used.add(i);
    while (key(ring[0]!) !== key(ring[ring.length - 1]!)) {
      const end = key(ring[ring.length - 1]!);
      const next = ends.get(end)?.find(id => !used.has(id));
      if (next === undefined) throw new Error("Board outline is not closed.");
      const p = paths[next]!; used.add(next);
      ring.push(...(key(p[0]!) === end ? p : [...p].reverse()).slice(1));
    }
    ring.pop(); rings.push(ring);
  }
  return rings;
}

export function boardIslands(paths: C.Paths): C.Paths[] {
  const clip = new C.Clipper(), tree = new C.PolyTree(), result: C.Paths[] = [];
  clip.AddPaths(paths, C.PolyType.ptSubject, true);
  clip.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  const visit = (node: C.PolyNode): void => {
    if (node.Contour().length && !node.IsHole()) result.push([node.Contour(), ...node.Childs().filter(n => n.IsHole()).map(n => n.Contour())]);
    node.Childs().forEach(visit);
  };
  visit(tree);
  return result;
}

export function extrude(paths: C.Paths, scale: number, height: number, depth?: number, profile?: C.Paths, bottom?: C.Paths, topEngraved = true): Buffer {
  if (!paths.length && !profile?.length) throw new Error("Gerber contains no solid artwork to import.");
  let triangles: number[][] = [];
  const tri = (a: number[], b: number[], c: number[]): void => {
    if (triangles.length >= 1_000_000) throw new Error("Converted model exceeds one million triangles.");
    triangles.push([...a, ...b, ...c]);
  };
  const surfaces = (paths: C.Paths, bottom: number, top: number, floor: boolean, roof: boolean, walls: boolean): void => {
    const tree = new C.PolyTree();
    const clip = new C.Clipper();
    clip.StrictlySimple = true;
    clip.AddPaths(paths, C.PolyType.ptSubject, true);
    clip.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const visit = (node: C.PolyNode): void => {
      if (node.Contour().length && !node.IsHole()) {
        const rings = [node.Contour(), ...node.Childs().filter(n => n.IsHole()).map(n => n.Contour())];
        const vertices: number[] = [], holes: number[] = [];
        rings.forEach((ring, index) => {
          if ((C.Clipper.Area(ring) > 0) !== (index === 0)) ring.reverse();
          if (index) holes.push(vertices.length / 2);
          for (const p of ring) vertices.push(p.X * scale, p.Y * scale);
          for (let i = 0; walls && i < ring.length; i++) {
            const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
            const a0 = [a.X * scale, a.Y * scale, bottom], b0 = [b.X * scale, b.Y * scale, bottom];
            const a1 = [a0[0]!, a0[1]!, top], b1 = [b0[0]!, b0[1]!, top];
            tri(a0, b0, b1); tri(a0, b1, a1);
          }
        });
        const indices = earcut(vertices, holes);
        const v = (i: number, z: number): number[] => [vertices[i * 2]!, vertices[i * 2 + 1]!, z];
        for (let i = 0; i < indices.length; i += 3) {
          const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
          if (roof) tri(v(a, top), v(b, top), v(c, top));
          if (floor) tri(v(c, bottom), v(b, bottom), v(a, bottom));
        }
      }
      for (const child of node.Childs()) visit(child);
    };
    visit(tree);
  };
  if (depth === undefined) surfaces(paths, 0, height, true, true, true);
  else {
    // A single layer has no board profile: use its bounds plus a 1 mm border.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of paths) for (const p of ring) {
      minX = Math.min(minX, p.X); minY = Math.min(minY, p.Y);
      maxX = Math.max(maxX, p.X); maxY = Math.max(maxY, p.Y);
    }
    const margin = Math.ceil(1 / scale);
    const board: C.Paths = profile ?? [[
      { X: minX - margin, Y: minY - margin }, { X: maxX + margin, Y: minY - margin },
      { X: maxX + margin, Y: maxY + margin }, { X: minX - margin, Y: maxY + margin }
    ]];
    paths = boolean(paths, board, C.ClipType.ctIntersection);
    if (bottom) bottom = boolean(bottom, board, C.ClipType.ctIntersection);
    const level = topEngraved ? height - depth : height, lower = bottom ? depth : 0;
    if (lower >= level) throw new Error("Engraving depths on both sides must leave a solid core.");
    surfaces(board, lower, level, !bottom, !topEngraved, true);
    if (topEngraved) {
      surfaces(boolean(board, paths, C.ClipType.ctDifference), level, level, false, true, false);
      surfaces(paths, level, height, false, true, true);
    }
    if (bottom) {
      surfaces(boolean(board, bottom, C.ClipType.ctDifference), lower, lower, true, false, false);
      surfaces(bottom, 0, lower, true, false, true);
    }
  }
  if (!triangles.length) throw new Error("Gerber contains no solid artwork to import.");
  triangles = stitchEdges(triangles);
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write("Nest Studio Gerber layer; millimetres");
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((v, i) => {
    const ux = v[3]! - v[0]!, uy = v[4]! - v[1]!, uz = v[5]! - v[2]!;
    const vx = v[6]! - v[0]!, vy = v[7]! - v[1]!, vz = v[8]! - v[2]!;
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const length = Math.hypot(...n) || 1;
    [...n.map(x => x / length), ...v].forEach((x, j) => buffer.writeFloatLE(x, 84 + i * 50 + j * 4));
  });
  return buffer;
}

/** Earcut can omit collinear boundary vertices. Split their opposite faces at the same vertices. */
function stitchEdges(triangles: number[][]): number[][] {
  const pointKey = (p: number[]): string => p.join(",");
  const edgeKey = (a: number[], b: number[]): string => [pointKey(a), pointKey(b)].sort().join("|");
  const edges = new Map<string, { count: number; a: number[]; b: number[] }>();
  for (const t of triangles) for (let i = 0; i < 3; i++) {
    const a = t.slice(i * 3, i * 3 + 3), j = (i + 1) % 3, b = t.slice(j * 3, j * 3 + 3), k = edgeKey(a, b);
    const edge = edges.get(k);
    if (edge) edge.count++; else edges.set(k, { count: 1, a, b });
  }
  const open = [...edges.entries()].filter(([, e]) => e.count === 1);
  if (!open.length) return triangles;
  const vertices = new Map<string, number[]>();
  for (const [, e] of open) for (const p of [e.a, e.b]) vertices.set(pointKey(p), p);
  if (open.length * vertices.size > 20_000_000) throw new Error("Board boundary is too complex to stitch; increase curve tolerance or simplify the source.");
  const splits = new Map<string, number[][]>();
  for (const [k, { a, b }] of open) {
    const d = b.map((v, i) => v - a[i]!), len2 = d.reduce((s, v) => s + v * v, 0);
    const points: { p: number[]; t: number }[] = [];
    for (const p of vertices.values()) {
      const t = p.reduce((s, v, i) => s + (v - a[i]!) * d[i]!, 0) / len2;
      if (t <= 1e-10 || t >= 1 - 1e-10) continue;
      if (p.every((v, i) => Math.abs(v - a[i]! - t * d[i]!) < 1e-8)) points.push({ p, t });
    }
    if (points.length) splits.set(k, [a, ...points.sort((a, b) => a.t - b.t).map(v => v.p), b]);
  }
  const result: number[][] = [];
  for (const t of triangles) {
    const ring: number[][] = [];
    for (let i = 0; i < 3; i++) {
      const a = t.slice(i * 3, i * 3 + 3), j = (i + 1) % 3, b = t.slice(j * 3, j * 3 + 3);
      const split = splits.get(edgeKey(a, b));
      ring.push(...(split ? (pointKey(split[0]!) === pointKey(a) ? split : [...split].reverse()).slice(0, -1) : [a]));
    }
    if (ring.length === 3) result.push(t);
    else {
      const center = [0, 1, 2].map(i => (t[i]! + t[i + 3]! + t[i + 6]!) / 3);
      for (let i = 0; i < ring.length; i++) result.push([...center, ...ring[i]!, ...ring[(i + 1) % ring.length]!]);
    }
    if (result.length > 1_000_000) throw new Error("Stitched model exceeds one million triangles.");
  }
  return result;
}
