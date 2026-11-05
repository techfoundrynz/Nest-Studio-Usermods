import * as fs from "node:fs/promises";
import * as path from "node:path";
import { unzipSync, zipSync } from "fflate";

const GCODE = /\.(nc|gcode|tap|ngc|cnc)$/i;
const MAX_BYTES = 256 * 1024 * 1024;
type Process = (text: string, context: { filePath: string; fileName: string; internal: boolean }) => Promise<string>;

/** Read only the ZIP directory, so even very large project saves bypass G-code processing. */
async function gcodeDirectory(file: string): Promise<{ names: string[]; total: number } | null> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const tail = Buffer.alloc(Math.min(size, 65557));
    await handle.read(tail, 0, tail.length, size - tail.length);
    let end = tail.length - 22;
    while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length)) end--;
    if (end < 0) return null;
    const length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (length > 8 * 1024 * 1024 || offset + length > size) return null;
    const directory = Buffer.alloc(length);
    await handle.read(directory, 0, length, offset);
    const names: string[] = [];
    let total = 0;
    for (let i = 0; i < length;) {
      if (i + 46 > length || directory.readUInt32LE(i) !== 0x02014b50) return null;
      const nameLength = directory.readUInt16LE(i + 28);
      const next = i + 46 + nameLength + directory.readUInt16LE(i + 30) + directory.readUInt16LE(i + 32);
      if (next > length) return null;
      const name = directory.toString("utf8", i + 46, i + 46 + nameLength);
      if (!name.endsWith("/")) {
        if (!GCODE.test(name)) return null;
        if (names.includes(name)) throw new Error("Duplicate path in G-code archive");
        names.push(name);
        total += directory.readUInt32LE(i + 24);
      }
      i = next;
    }
    return names.length ? { names, total } : null;
  } finally { await handle.close(); }
}

/** Called on the vendor's closed temporary file, before its atomic rename. Project ZIPs are untouched. */
export async function transformExportFile(temporaryPath: string, targetPath: string, process: Process): Promise<void> {
  if (!GCODE.test(targetPath) && !/\.zip$/i.test(targetPath)) return;
  const archive = GCODE.test(targetPath) ? null : await gcodeDirectory(temporaryPath);
  if (!GCODE.test(targetPath) && !archive) return;
  const stat = await fs.stat(temporaryPath);
  if (stat.size > MAX_BYTES) throw new Error("Usermod export exceeds the 256 MiB processing limit; export fewer operations at a time.");
  const bytes = await fs.readFile(temporaryPath);
  if (GCODE.test(targetPath)) {
    const text = await process(bytes.toString("utf8"), { filePath: targetPath, fileName: path.basename(targetPath), internal: false });
    await fs.writeFile(temporaryPath, text, "utf8");
    return;
  }
  const { names, total } = archive!;
  if (total > MAX_BYTES) throw new Error("Expanded G-code export exceeds the 256 MiB processing limit.");
  const entries = unzipSync(bytes);
  for (const [index, name] of names.entries()) {
    if (name.includes("..") || /^[\\/]|^[a-z]:/i.test(name)) throw new Error("Unsafe path in G-code archive");
    // Sidecar reports and tool splits use a distinct virtual file name per archive entry.
    const fileName = `${path.basename(targetPath, ".zip")}-${index + 1}-${name.replace(/[\\/]/g, "_")}`;
    const text = await process(Buffer.from(entries[name]!).toString("utf8"), { filePath: path.join(path.dirname(targetPath), fileName), fileName, internal: false });
    entries[name] = Buffer.from(text, "utf8");
  }
  await fs.writeFile(temporaryPath, zipSync(entries));
}
