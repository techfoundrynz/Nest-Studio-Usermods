import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import { MAX_INPUT } from "./geometry";
import { MAX_ZIP, type BundleSummary } from "./bundle";

const EXTENSIONS = ["grb", "gbr", "ger", "gerber", "gtl", "gbl", "gts", "gbs", "gto", "gbo", "gtp", "gbp", "gko", "gm1"];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const isGerber = (name: string): boolean => EXTENSIONS.includes(path.extname(name).slice(1).toLowerCase());
interface Settings { thicknessMm: number; toleranceMm: number; engraveDepthMm: number }
interface ImportOptions { thicknessMm: number; engraveDepthMm: number; splitGapMm?: number; sides?: "top" | "bottom" | "both"; includeDrills?: boolean; autoImport?: boolean }
interface WorkerResult { bytes?: Uint8Array; additional?: Uint8Array[]; summary?: BundleSummary | null; error?: string }
function workerJob(data: Record<string, unknown>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "worker.js"), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Gerber processing exceeded 30 seconds; simplify the package.")); }, 30_000);
    worker.once("message", (result: WorkerResult) => { clearTimeout(timer); void worker.terminate(); if (result.error) reject(new Error(result.error)); else resolve(result); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.once("exit", code => { clearTimeout(timer); reject(new Error(`Gerber worker exited (${code}).`)); });
  });
}
const archiveBytes = (raw: unknown): Uint8Array => {
  if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_ZIP) throw new Error("Gerber ZIP must be at most 16 MiB.");
  return raw;
};

const mod: Usermod.MainMod<Settings> = {
  description: "Gerber layers through the native model Open dialog and file-drop workflow",
  activate(api) {
    const imports = new Map<string, { source: string; options: ImportOptions; zip?: boolean }>();
    const pending = new Map<string, (options: ImportOptions | null) => void>();
    const readSettings = async (): Promise<Partial<Settings>> => api.modDir
      ? JSON.parse(await readFile(path.join(api.modDir, "mods.json"), "utf8")).settings?.["pcb-import"] ?? {}
      : api.settings;
    api.handle("pcb:answer", (id, raw) => {
      if (typeof id !== "string" || !pending.has(id)) throw new Error("This PCB import prompt has expired.");
      if (raw !== null && (!record(raw) || typeof raw.thicknessMm !== "number" || typeof raw.engraveDepthMm !== "number"
        || !Number.isFinite(raw.thicknessMm) || raw.thicknessMm < 0.01 || raw.thicknessMm > 100
        || !Number.isFinite(raw.engraveDepthMm) || raw.engraveDepthMm <= 0 || raw.engraveDepthMm >= raw.thicknessMm)) {
        throw new Error("Enter a board thickness of 0.01–100 mm and a positive depth less than that thickness.");
      }
      if (record(raw) && raw.splitGapMm !== undefined && (typeof raw.splitGapMm !== "number" || !Number.isFinite(raw.splitGapMm)
        || (raw.splitGapMm !== 0 && (raw.splitGapMm < 2 || raw.splitGapMm > 100)))) throw new Error("Board separation gap must be 2–100 mm, or zero to keep a panel together.");
      if (record(raw) && ((raw.sides !== undefined && !["top", "bottom", "both"].includes(String(raw.sides))) || (raw.includeDrills !== undefined && typeof raw.includeDrills !== "boolean"))) throw new Error("Invalid package options.");
      if (record(raw) && raw.autoImport !== undefined && typeof raw.autoImport !== "boolean") throw new Error("Invalid batch import option.");
      pending.get(id)!(raw as ImportOptions | null);
    });
    const ask = async (name: string, summary?: BundleSummary): Promise<ImportOptions | null> => {
      if (pending.size) throw new Error("Finish the current PCB import prompt first.");
      const settings = await readSettings();
      if (pending.size) throw new Error("Finish the current PCB import prompt first.");
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id); api.send("pcb:prompt-expired", id);
          reject(new Error("PCB import prompt timed out. Please import the file again."));
        }, 300_000);
        pending.set(id, options => { clearTimeout(timer); pending.delete(id); resolve(options); });
        api.send("pcb:prompt", { id, name, summary, thicknessMm: settings.thicknessMm ?? 1.6, engraveDepthMm: settings.engraveDepthMm ?? 0.1 });
      });
    };
    let busy = false;
    const convert = async (text: unknown, options: ImportOptions, name: string): Promise<Uint8Array> => {
      const archive = text instanceof Uint8Array ? archiveBytes(text) : undefined;
      if (!archive && (typeof text !== "string" || Buffer.byteLength(text) > MAX_INPUT)) throw new Error("Gerber input must be text, at most 8 MiB.");
      if (busy) throw new Error("A PCB layer is already being converted. Please wait.");
      busy = true;
      try {
        // MainModApi.settings is the activation snapshot; read saved values for each import.
        const settings = await readSettings();
        const result = await workerJob({ text: archive ? undefined : text, archive, thickness: options.thicknessMm, depth: options.engraveDepthMm, tolerance: settings.toleranceMm ?? 0.01, splitGap: options.splitGapMm ?? 2, sides: options.sides, includeDrills: options.includeDrills });
        if (!result.bytes) throw new Error("Gerber conversion returned no model.");
        if (options.autoImport) api.send("pcb:batch", [result.bytes, ...result.additional ?? []].map((bytes, i) => ({ name: `${name}-board-${i + 1}.stl`, bytes })));
        else if (result.additional?.length) api.send("pcb:boards", result.additional.map((bytes, i) => ({ name: `${name}-board-${i + 2}.stl`, bytes })));
        return result.bytes;
      } finally { busy = false; }
    };
    api.handle("pcb:convert", async (text, name) => {
      if (typeof text !== "string" || Buffer.byteLength(text) > MAX_INPUT) throw new Error("Gerber input must be text, at most 8 MiB.");
      const options = await ask(typeof name === "string" ? name : "Gerber layer");
      if (!options) return null;
      const bytes = await convert(text, options, typeof name === "string" ? name : "Gerber");
      return options.autoImport ? null : bytes;
    });
    api.handle("pcb:zip", async (raw, name) => {
      const archive = archiveBytes(raw);
      const { summary } = await workerJob({ archive, inspect: true });
      if (!summary) return { recognized: false };
      const label = typeof name === "string" ? name : "Gerber ZIP";
      const options = await ask(label, summary);
      const bytes = options ? await convert(archive, options, label) : null;
      return { recognized: true, bytes: options?.autoImport ? null : bytes };
    });
    api.intercept("dialog:show-open", {
      before(args) {
        const options = args[0];
        if (!record(options) || !Array.isArray(options.filters)) return;
        const modelDialog = options.filters.some(f => record(f) && Array.isArray(f.extensions) && f.extensions.includes("stl"));
        if (!modelDialog) return;
        return [{ ...options, filters: [
          ...options.filters.map(f => record(f) && Array.isArray(f.extensions) && f.extensions.includes("stl")
            ? { ...f, extensions: [...new Set([...f.extensions, ...EXTENSIONS, "zip"])] } : f),
          { name: "Gerber PCB layer", extensions: [...EXTENSIONS, "zip"] }
        ] }, ...args.slice(1)];
      },
      async after(result, args) {
        const options = args[0];
        if (!record(options) || !Array.isArray(options.filters) || !options.filters.some(f => record(f) && f.name === "Gerber PCB layer")) return;
        if (!record(result) || !result.ok || !record(result.data) || result.data.canceled) return;
        const data = result.data;
        const paths = Array.isArray(data.filePaths) ? data.filePaths : [data.filePath];
        const zipSummaries = new Map<string, BundleSummary>();
        for (const file of paths) if (typeof file === "string" && /\.zip$/i.test(file)) {
          try {
            if ((await stat(file)).size > MAX_ZIP) continue;
            const { summary } = await workerJob({ archive: await readFile(file), inspect: true });
            if (summary) zipSummaries.set(file, summary);
          } catch (error) { api.log("ZIP inspection deferred to native project importer", String(error)); }
        }
        const gerbers = paths.filter((p): p is string => typeof p === "string" && isGerber(p));
        gerbers.push(...zipSummaries.keys());
        if (!gerbers.length) return result;
        let chosen: ImportOptions | null;
        try { chosen = await ask(gerbers.map(p => path.basename(p)).join(", "), zipSummaries.values().next().value); }
        catch (error) { api.send("pcb:error", error instanceof Error ? error.message : String(error)); chosen = null; }
        if (!chosen) return { ...result, data: { canceled: true } };
        if (chosen.autoImport) {
          try {
            // The renderer bridge creates/reuses the project and imports ALL boards. Do not also
            // return an STL alias to the native Open path, which would import the first board twice.
            for (const file of gerbers) {
              const zip = zipSummaries.has(file);
              if ((await stat(file)).size > (zip ? MAX_ZIP : MAX_INPUT)) throw new Error("Gerber input exceeds the file size limit.");
              const bytes = await readFile(file);
              await convert(zip ? bytes : bytes.toString("utf8"), chosen, path.basename(file));
            }
          } catch (error) { api.send("pcb:error", error instanceof Error ? error.message : String(error)); }
          return { ...result, data: { canceled: true } };
        }
        const importOptions = chosen;
        const converted = paths.map(original => {
          if (typeof original !== "string" || (!isGerber(original) && !zipSummaries.has(original))) return original;
          // Only aliases issued by a successful native dialog can read an original path.
          const alias = path.join(path.dirname(original), `.pcb-import-${randomUUID()}`, `${path.basename(original)}.stl`);
          imports.set(alias, { source: original, options: importOptions, zip: zipSummaries.has(original) });
          while (imports.size > 32) imports.delete(imports.keys().next().value!);
          return alias;
        });
        return { ...result, data: { ...data, filePaths: converted, filePath: converted[0] } };
      }
    });
    api.intercept("store:read-binary-file", {
      before(args) {
        const alias = args[0];
        if (typeof alias !== "string" || !imports.has(alias)) return;
        return [imports.get(alias)!.source, { pcbAlias: alias }];
      },
      async after(result, args) {
        const marker = args[1];
        if (!record(marker) || typeof marker.pcbAlias !== "string") return;
        const selected = imports.get(marker.pcbAlias);
        if (!selected || selected.source !== args[0]) return;
        imports.delete(marker.pcbAlias);
        if (!record(result) || !result.ok) return;
        try {
          const bytes = result.data;
          if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) throw new Error("Nest Studio returned an unsupported binary-file response.");
          if (bytes.length > (selected.zip ? MAX_ZIP : MAX_INPUT)) throw new Error("Gerber input exceeds the file size limit.");
          const stl = await convert(selected.zip ? Buffer.from(bytes) : Buffer.from(bytes).toString("utf8"), selected.options, path.basename(selected.source));
          api.log("Imported PCB layer", args[0], stl.byteLength, "STL bytes");
          return { ...result, data: stl };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.send("pcb:error", message);
          return { ok: false, code: "PCB_IMPORT_FAILED", message };
        }
      }
    });
  }
};
export = mod;
