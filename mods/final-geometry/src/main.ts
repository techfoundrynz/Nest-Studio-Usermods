/*
 * Final geometry (main): writes the machined-stock height field the UI half extracted from the simulation as a
 * binary STL. Top surface per solid column, vertical walls where a solid cell meets a cut-through cell or the
 * stock edge, and a flat bottom, so slicers and CAD see a closed solid.
 *
 * IPC: final:export-stl({ filePath, nx, ny, minX, minY, dx, dy, minZ, stride, heights: Float32Array }) → { path, triangles }
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface ExportRequest {
  filePath: string;
  nx: number;
  ny: number;
  minX: number;
  minY: number;
  dx: number;
  dy: number;
  minZ: number;
  stride: number;
  heights: Float32Array;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function parseRequest(raw: unknown): ExportRequest {
  if (!isRecord(raw)) throw new Error("bad request");
  const { filePath, nx, ny, minX, minY, dx, dy, minZ, stride, heights } = raw;
  if (typeof filePath !== "string" || !filePath) throw new Error("filePath required");
  if (!finite(nx) || !finite(ny) || nx < 2 || ny < 2) throw new Error("grid size invalid");
  if (!finite(minX) || !finite(minY) || !finite(dx) || !finite(dy) || !finite(minZ)) throw new Error("grid frame invalid");
  const h = heights instanceof Float32Array ? heights : ArrayBuffer.isView(heights) ? new Float32Array(heights.buffer, heights.byteOffset, heights.byteLength / 4) : null;
  if (!h || h.length !== nx * ny) throw new Error("heights do not match the grid");
  return { filePath, nx, ny, minX, minY, dx, dy, minZ, stride: finite(stride) && stride >= 1 ? Math.floor(stride) : 1, heights: h };
}

class StlWriter {
  private chunks: Buffer[] = [];
  private buf = Buffer.alloc(50 * 4096);
  private used = 0;
  count = 0;
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    // Normal from the winding (counter-clockwise seen from outside).
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    if (this.used + 50 > this.buf.length) this.flush();
    const b = this.buf;
    let o = this.used;
    for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      b.writeFloatLE(v, o);
      o += 4;
    }
    b.writeUInt16LE(0, o);
    this.used = o + 2;
    this.count += 1;
  }
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): void {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz);
  }
  private flush(): void {
    this.chunks.push(Buffer.from(this.buf.subarray(0, this.used)));
    this.used = 0;
  }
  toBuffer(name: string): Buffer {
    this.flush();
    const header = Buffer.alloc(84);
    header.write(name.slice(0, 79), 0, "latin1");
    header.writeUInt32LE(this.count, 80);
    return Buffer.concat([header, ...this.chunks]);
  }
}

function buildStl(r: ExportRequest): Buffer {
  const { nx, ny, minX, minY, dx, dy, minZ, stride, heights } = r;
  const eps = 1e-4;
  const cols = Math.floor((nx - 1) / stride);
  const rows = Math.floor((ny - 1) / stride);
  const H = (ix: number, iy: number): number => heights[Math.min(ny - 1, iy * stride) * nx + Math.min(nx - 1, ix * stride)] ?? minZ;
  const solid = (ix: number, iy: number): boolean => ix >= 0 && iy >= 0 && ix <= cols && iy <= rows && H(ix, iy) > minZ + eps;
  const X = (ix: number): number => minX + Math.min(nx - 1, ix * stride) * dx;
  const Y = (iy: number): number => minY + Math.min(ny - 1, iy * stride) * dy;
  const w = new StlWriter();
  for (let iy = 0; iy < rows; iy += 1) {
    for (let ix = 0; ix < cols; ix += 1) {
      const s00 = solid(ix, iy);
      const s10 = solid(ix + 1, iy);
      const s01 = solid(ix, iy + 1);
      const s11 = solid(ix + 1, iy + 1);
      if (!(s00 && s10 && s01 && s11)) continue;
      const x0 = X(ix);
      const x1 = X(ix + 1);
      const y0 = Y(iy);
      const y1 = Y(iy + 1);
      // top (normal +Z)
      w.quad(x0, y0, H(ix, iy), x1, y0, H(ix + 1, iy), x1, y1, H(ix + 1, iy + 1), x0, y1, H(ix, iy + 1));
      // bottom (normal -Z)
      w.quad(x0, y0, minZ, x0, y1, minZ, x1, y1, minZ, x1, y0, minZ);
      // walls where the neighbouring cell quad is missing
      const cell = (cx: number, cy: number): boolean => solid(cx, cy) && solid(cx + 1, cy) && solid(cx, cy + 1) && solid(cx + 1, cy + 1);
      if (!cell(ix, iy - 1)) w.quad(x0, y0, minZ, x1, y0, minZ, x1, y0, H(ix + 1, iy), x0, y0, H(ix, iy)); // -Y side
      if (!cell(ix, iy + 1)) w.quad(x1, y1, minZ, x0, y1, minZ, x0, y1, H(ix, iy + 1), x1, y1, H(ix + 1, iy + 1)); // +Y side
      if (!cell(ix - 1, iy)) w.quad(x0, y1, minZ, x0, y0, minZ, x0, y0, H(ix, iy), x0, y1, H(ix, iy + 1)); // -X side
      if (!cell(ix + 1, iy)) w.quad(x1, y0, minZ, x1, y1, minZ, x1, y1, H(ix + 1, iy + 1), x1, y0, H(ix + 1, iy)); // +X side
    }
  }
  return w.toBuffer(`Nest Studio usermod final-geometry ${cols}x${rows}`);
}

const mod: Usermod.MainMod = {
  description: "Binary STL writer for the simulated machined stock (final:export-stl)",
  activate(api) {
    api.handle("final:export-stl", (raw: unknown) => {
      const req = parseRequest(raw);
      const dir = path.dirname(req.filePath);
      if (!fs.existsSync(dir)) throw new Error(`folder does not exist: ${dir}`);
      const buffer = buildStl(req);
      fs.writeFileSync(req.filePath, buffer);
      const triangles = buffer.readUInt32LE(80);
      api.log(`wrote ${req.filePath}: ${triangles} triangles (stride ${req.stride})`);
      return { path: req.filePath, triangles, bytes: buffer.length };
    });
  }
};

export = mod;
