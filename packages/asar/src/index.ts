/*
 * Minimal dependency-free asar library (Electron archive format).
 *
 * pack() reuses the ORIGINAL archive's header as a template: every file keeps its packed/unpacked
 * status, packed files are re-read from the staging directory (so patched files are picked up), and
 * integrity blocks are dropped (Nest Studio's fuses do not validate them). Unpacked files continue to
 * live in app.asar.unpacked next to the archive, untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface AsarFile {
  size: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
  integrity?: unknown;
}
export interface AsarDirectory {
  files: Record<string, AsarEntry>;
}
export type AsarEntry = AsarFile | AsarDirectory;

interface OpenArchive {
  fd: number;
  header: AsarDirectory;
  dataBase: number;
}

export function isDirectory(entry: AsarEntry): entry is AsarDirectory {
  return "files" in entry;
}

export function readHeader(asarPath: string): OpenArchive {
  const fd = fs.openSync(asarPath, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // Pickle layout: [u32 4][u32 headerPickleSize][u32 headerPayloadSize][u32 jsonLength][json...]
  const headerPickleSize = head.readUInt32LE(4);
  const jsonLength = head.readUInt32LE(12);
  const jsonBuffer = Buffer.alloc(jsonLength);
  fs.readSync(fd, jsonBuffer, 0, jsonLength, 16);
  return { fd, header: JSON.parse(jsonBuffer.toString("utf8")) as AsarDirectory, dataBase: 8 + headerPickleSize };
}

/** Unpacked files live in <archive>.unpacked. For a renamed backup (app.asar.orig) fall back to the
 * sibling app.asar.unpacked directory, which the backup shares with the live archive. */
export function unpackedRootFor(asarPath: string): string {
  const candidates = [`${asarPath}.unpacked`, path.join(path.dirname(asarPath), "app.asar.unpacked")];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0]!;
}

export type Visitor = (rel: string, entry: AsarEntry, isDir: boolean) => void;
export function walk(node: AsarDirectory, relPath: string, visit: Visitor): void {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const rel = relPath ? `${relPath}/${name}` : name;
    if (isDirectory(entry)) {
      visit(rel, entry, true);
      walk(entry, rel, visit);
    } else {
      visit(rel, entry, false);
    }
  }
}

function copyRange(fdIn: number, position: number, size: number, fdOut: number): void {
  const chunk = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
  let remaining = size;
  while (remaining > 0) {
    const n = fs.readSync(fdIn, chunk, 0, Math.min(remaining, chunk.length), position);
    if (n <= 0) throw new Error("short read");
    fs.writeSync(fdOut, chunk, 0, n);
    remaining -= n;
    position += n;
  }
}

export interface ExtractResult {
  packed: number;
  unpacked: number;
  bytes: number;
  missingUnpacked: string[];
}
export function extract(asarPath: string, outDir: string): ExtractResult {
  const { fd, header, dataBase } = readHeader(asarPath);
  const unpackedRoot = unpackedRootFor(asarPath);
  const result: ExtractResult = { packed: 0, unpacked: 0, bytes: 0, missingUnpacked: [] };
  fs.mkdirSync(outDir, { recursive: true });
  walk(header, "", (rel, entry, isDir) => {
    const target = path.join(outDir, rel);
    if (isDir || isDirectory(entry)) {
      fs.mkdirSync(target, { recursive: true });
      return;
    }
    if (entry.link) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.unpacked) {
      const source = path.join(unpackedRoot, rel);
      if (!fs.existsSync(source)) {
        result.missingUnpacked.push(source);
        return;
      }
      fs.copyFileSync(source, target);
      result.unpacked += 1;
      result.bytes += entry.size;
      return;
    }
    const out = fs.openSync(target, "w");
    copyRange(fd, dataBase + Number(entry.offset), entry.size, out);
    fs.closeSync(out);
    result.packed += 1;
    result.bytes += entry.size;
  });
  fs.closeSync(fd);
  return result;
}

export interface PackResult {
  files: number;
  payloadBytes: number;
}
export function pack(originalAsar: string, stagingDir: string, outAsar: string): PackResult {
  const { fd, header } = readHeader(originalAsar);
  fs.closeSync(fd);
  const plan: { source: string; size: number }[] = [];
  let offset = 0;
  walk(header, "", (rel, entry, isDir) => {
    if (isDir || isDirectory(entry) || entry.link) return;
    delete entry.integrity;
    const source = path.join(stagingDir, rel);
    if (entry.unpacked) {
      // Unpacked files are not written into the archive; they stay in app.asar.unpacked untouched.
      if (fs.existsSync(source)) entry.size = fs.statSync(source).size;
      return;
    }
    if (!fs.existsSync(source)) throw new Error(`staging file missing: ${source}`);
    const size = fs.statSync(source).size;
    entry.size = size;
    entry.offset = String(offset);
    plan.push({ source, size });
    offset += size;
  });
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0); // pickle payload size
  headerPickle.writeUInt32LE(json.length, 4); // string length
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);

  const tmp = `${outAsar}.tmp`;
  fs.mkdirSync(path.dirname(outAsar), { recursive: true });
  const out = fs.openSync(tmp, "w");
  fs.writeSync(out, sizePickle);
  fs.writeSync(out, headerPickle);
  for (const item of plan) {
    const src = fs.openSync(item.source, "r");
    copyRange(src, 0, item.size, out);
    fs.closeSync(src);
  }
  fs.closeSync(out);
  fs.renameSync(tmp, outAsar);
  return { files: plan.length, payloadBytes: offset };
}

/** Read one file out of the archive (or its unpacked sibling) without extracting everything. */
export function readEntry(asarPath: string, relPath: string): Buffer {
  const { fd, header, dataBase } = readHeader(asarPath);
  const wanted = relPath.replace(/\\/g, "/");
  let found: AsarFile | null = null;
  walk(header, "", (rel, entry, isDir) => {
    if (!isDir && !isDirectory(entry) && rel === wanted) found = entry;
  });
  if (!found) {
    fs.closeSync(fd);
    throw new Error(`not in archive: ${relPath}`);
  }
  const file: AsarFile = found;
  if (file.unpacked) {
    fs.closeSync(fd);
    return fs.readFileSync(path.join(unpackedRootFor(asarPath), wanted));
  }
  const buffer = Buffer.alloc(file.size);
  fs.readSync(fd, buffer, 0, file.size, dataBase + Number(file.offset));
  fs.closeSync(fd);
  return buffer;
}

export interface ListedEntry {
  path: string;
  size: number;
  unpacked: boolean;
}
export function list(asarPath: string): ListedEntry[] {
  const { fd, header } = readHeader(asarPath);
  fs.closeSync(fd);
  const entries: ListedEntry[] = [];
  walk(header, "", (rel, entry, isDir) => {
    if (isDir || isDirectory(entry) || entry.link) return;
    entries.push({ path: rel, size: entry.size, unpacked: Boolean(entry.unpacked) });
  });
  return entries;
}
