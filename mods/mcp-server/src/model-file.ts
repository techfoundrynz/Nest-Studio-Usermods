import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_MODEL_BYTES = 32 * 1024 * 1024;
/** Read only model files for the native importer, never generic files/directories. */
export async function readModelFile(filePath: string): Promise<{ name: string; base64: string }> {
  if (!path.isAbsolute(filePath)) throw new Error("Provide an absolute model file path");
  const resolved = await fs.realpath(filePath);
  if (!/\.(step|stp|stl)$/i.test(resolved)) throw new Error("open_file supports STEP, STP and STL model files");
  const file = await fs.open(resolved, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MODEL_BYTES) throw new Error("Model must be a nonempty regular file no larger than 32 MiB");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) throw new Error("Model changed while reading; retry after saving it");
    return { name: path.basename(resolved), base64: bytes.subarray(0, length).toString("base64") };
  } finally { await file.close(); }
}
