/** Transform only explicit G-code fields, preserving CAM metadata and response structure. */
export async function transformResult(value: unknown, process: (gcode: string) => Promise<string>): Promise<unknown> {
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) output.push(await transformResult(item, process));
    return output;
  }
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = key === "gcode" && typeof child === "string" ? await process(child) : await transformResult(child, process);
  }
  return output;
}
