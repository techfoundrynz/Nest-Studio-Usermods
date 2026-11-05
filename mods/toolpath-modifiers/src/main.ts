import { transformResult } from "./result";

const TOOLPATH_ENDPOINTS = new Set([
  "/api/commonPath", "/api/finePath", "/api/camberPath", "/api/allChamferPath", "/api/cutTab",
  "/api/parallelPath", "/api/drillPath", "/api/threadPath", "/api/chamferPath", "/api/contourPath",
  "/api/pocketPath", "/api/smartCutPath", "/api/fourAxisPath"
]);
interface Settings { preview: string[]; camPort: number; maxBytes: number; }
interface LastRun { endpoint: string; time: number; ms: number; bytesIn: number; bytesOut: number; changed: boolean; error: string | null; }
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const mod: Usermod.MainMod<Settings> = {
  description: "Applies preview processors to inline and file-backed CAM toolpaths",
  activate(api) {
    const camPort = Number(api.settings.camPort) > 0 ? Number(api.settings.camPort) : 9630;
    const maxBytes = Number(api.settings.maxBytes) > 0 ? Number(api.settings.maxBytes) : 64 * 1024 * 1024;
    const status = { intercepting: true, reason: null as string | null, count: 0, last: null as LastRun | null };
    api.handle("modifiers:status", () => status);
    async function process(value: unknown, endpoint: string, plain: boolean): Promise<unknown> {
      const started = Date.now();
      const run: LastRun = { endpoint, time: started, ms: 0, bytesIn: 0, bytesOut: 0, changed: false, error: null };
      const transform = async (text: string): Promise<string> => {
        const size = Buffer.byteLength(text);
        run.bytesIn += size;
        if (run.bytesIn > maxBytes) throw new Error(`CAM G-code exceeds ${maxBytes} bytes; modifiers left unapplied`);
        const output = await api.runPostprocessors("preview", text, { endpoint, fileName: "toolpath.nc" });
        run.bytesOut += Buffer.byteLength(output);
        run.changed ||= output !== text;
        return output;
      };
      try {
        const output = plain && typeof value === "string" ? await transform(value) : await transformResult(value, transform);
        run.ms = Date.now() - started;
        if (run.bytesIn) { status.count++; status.last = run; }
        if (run.changed) api.send("modifiers:applied", run);
        return output;
      } catch (error) {
        run.error = error instanceof Error ? error.message : String(error);
        run.ms = Date.now() - started;
        status.last = run;
        api.warn(`${endpoint}: ${run.error}`);
        return value;
      }
    }
    // The native handler validates and reads files. Never open renderer-provided paths ourselves.
    for (const channel of ["cam:read-toolpaths", "cam:read-process-tree"]) {
      api.intercept(channel, { after: async (result, args) => {
        if (!isRecord(result) || result.ok !== true) return;
        const plain = channel === "cam:read-process-tree" && typeof args[0] === "string" && /\.(nc|gcode|tap|ngc|cnc)$/i.test(args[0]);
        if (channel === "cam:read-process-tree" && !plain) return;
        return { ...result, data: await process(result.data, channel, plain) };
      } });
    }
    api.log("intercepting file-backed CAM toolpaths (STL, relief and STEP)");
    // Custom operations still return inline G-code over HTTP.
    void api.whenReady().then(() => {
      if (processEnvHarness()) return;
      const { session, net } = api.electron;
      const ses = session?.defaultSession;
      if (!ses || typeof ses.protocol?.handle !== "function" || typeof net?.fetch !== "function") {
        status.reason = "File-backed CAM active; inline HTTP interception unavailable";
        return;
      }
      const passthrough = (request: Request): Promise<Response> => net.fetch(request, { bypassCustomProtocolHandlers: true });
      ses.protocol.handle("http", async request => {
        const url = new URL(request.url);
        const isCam = (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === String(camPort);
        const response = await passthrough(request);
        if (!isCam || !TOOLPATH_ENDPOINTS.has(url.pathname) || !response.ok) return response;
        const fallback = response.clone();
        try {
          const size = Number(response.headers.get("content-length") ?? "0");
          if (size > maxBytes) return response;
          const text = await response.text();
          if (Buffer.byteLength(text) > maxBytes) return fallback;
          const json = /^[\s]*[\[{]/.test(text);
          const data: unknown = json ? JSON.parse(text) : text;
          const output = await process(data, url.pathname, !json);
          const body = json ? JSON.stringify(output) : String(output);
          const headers = new Headers(response.headers);
          headers.delete("content-length"); headers.delete("content-encoding");
          return new Response(body, { status: response.status, statusText: response.statusText, headers });
        } catch (error) {
          api.warn(`CAM response left unchanged: ${error instanceof Error ? error.message : String(error)}`);
          return fallback; // never re-issue a stateful CAM generation request
        }
      });
    });
  }
};
function processEnvHarness(): boolean { return Boolean(process.env.USERMOD_HARNESS); }
export = mod;
