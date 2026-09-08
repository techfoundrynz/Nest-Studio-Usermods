/*
 * Toolpath modifiers (main): post-processors normally run when a file is exported or a program is sent, so the
 * Preview tab shows the CAM's raw toolpaths. This mod intercepts the renderer's HTTP calls to the local CAM
 * service (protocol.handle on http:) and, for the toolpath endpoints, runs the post-processors the user picked
 * for the "preview" stage on the returned G-code before the app ever sees it. The modified toolpath is then
 * what the Preview tab draws, what the project saves, and what export and send start from; the loader marks
 * the G-code so those later stages skip the processors already applied.
 *
 * Every other request passes straight through (net.fetch with bypassCustomProtocolHandlers). Only responses
 * under maxBytes are transformed; larger ones stream untouched.
 *
 * IPC: modifiers:status. mods.json settings ("toolpath-modifiers"): preview (string[] of post-processor names),
 *   camPort (9630), maxBytes (64 MB)
 */
const TOOLPATH_ENDPOINTS = new Set([
  "/api/commonPath",
  "/api/finePath",
  "/api/camberPath",
  "/api/allChamferPath",
  "/api/cutTab",
  "/api/parallelPath",
  "/api/drillPath",
  "/api/threadPath",
  "/api/chamferPath",
  "/api/contourPath",
  "/api/pocketPath",
  "/api/smartCutPath",
  "/api/fourAxisPath"
]);

interface Settings {
  preview: string[];
  camPort: number;
  maxBytes: number;
}
interface LastRun {
  endpoint: string;
  time: number;
  ms: number;
  bytesIn: number;
  bytesOut: number;
  changed: boolean;
  error: string | null;
}
interface Status {
  intercepting: boolean;
  reason: string | null;
  count: number;
  last: LastRun | null;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The CAM wraps its G-code as {"gcode": "..."} (plus other keys); some endpoints return plain text. */
function splitBody(text: string): { gcode: string; wrap: ((gcode: string) => string) | null } {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && typeof parsed.gcode === "string") {
        return { gcode: parsed.gcode, wrap: (gcode) => JSON.stringify({ ...parsed, gcode }) };
      }
    } catch {
      /* not JSON after all */
    }
    return { gcode: "", wrap: null };
  }
  return { gcode: text, wrap: (gcode) => gcode };
}

const mod: Usermod.MainMod<Settings> = {
  description: "Applies chosen post-processors to CAM toolpaths as they are generated (modifiers:status)",
  activate(api) {
    const camPort = Number(api.settings.camPort) > 0 ? Number(api.settings.camPort) : 9630;
    const maxBytes = Number(api.settings.maxBytes) > 0 ? Number(api.settings.maxBytes) : 64 * 1024 * 1024;
    const status: Status = { intercepting: false, reason: null, count: 0, last: null };
    api.handle("modifiers:status", () => status);

    const { session, net } = api.electron;
    void api.whenReady().then(() => {
      if (process.env.USERMOD_HARNESS) {
        status.reason = "harness run";
        return;
      }
      const ses = session?.defaultSession;
      if (!ses || typeof ses.protocol?.handle !== "function" || typeof net?.fetch !== "function") {
        status.reason = "protocol.handle / net.fetch unavailable in this Electron";
        api.warn(status.reason);
        return;
      }
      const passthrough = (request: Request): Promise<Response> => net.fetch(request, { bypassCustomProtocolHandlers: true });
      ses.protocol.handle("http", async (request) => {
        let url: URL;
        try {
          url = new URL(request.url);
        } catch {
          return passthrough(request);
        }
        const isCam = (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === String(camPort);
        if (!isCam || !TOOLPATH_ENDPOINTS.has(url.pathname)) return passthrough(request);
        const retry = request.clone(); // a body can only be read once; keep a copy for the fallback below
        const response = await passthrough(request);
        const length = Number(response.headers.get("content-length") ?? "0");
        if (!response.ok || (length > 0 && length > maxBytes)) return response;
        const started = Date.now();
        const run: LastRun = { endpoint: url.pathname, time: started, ms: 0, bytesIn: 0, bytesOut: 0, changed: false, error: null };
        try {
          const text = await response.text();
          run.bytesIn = text.length;
          if (text.length > maxBytes) throw new Error(`response larger than ${maxBytes} bytes, left untouched`);
          const { gcode, wrap } = splitBody(text);
          let body = text;
          if (wrap && gcode) {
            const processed = await api.runPostprocessors("preview", gcode, { endpoint: url.pathname, fileName: `${url.pathname.slice(5)}.nc` });
            if (processed !== gcode) {
              body = wrap(processed);
              run.changed = true;
            }
          }
          run.bytesOut = body.length;
          run.ms = Date.now() - started;
          status.count += 1;
          status.last = run;
          if (run.changed) api.send("modifiers:applied", run);
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          headers.delete("content-encoding");
          return new Response(body, { status: response.status, statusText: response.statusText, headers });
        } catch (error) {
          run.error = error instanceof Error ? error.message : String(error);
          run.ms = Date.now() - started;
          status.last = run;
          api.warn(`${url.pathname}: ${run.error}`);
          // The response body was consumed; re-issue the request so the app still gets its toolpath.
          return passthrough(retry);
        }
      });
      status.intercepting = true;
      api.log(`intercepting CAM toolpath responses on port ${camPort}`);
    });
  }
};

export = mod;
