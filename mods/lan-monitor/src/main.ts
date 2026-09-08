/*
 * LAN monitor (main): a tiny read-only HTTP server so a phone or a second PC on the workshop network can see
 * the machine: status, program, progress bar, ETA, feed/spindle and the latest camera frame the machine
 * streams to the app (overall or top view). Nothing on the page can control the machine.
 *
 *   GET /               the page (auto-refreshing)
 *   GET /api/status     JSON: machine-state (api.call("machine:state")), host name, time
 *   GET /api/camera.jpg latest frame (404 until one arrives)
 *
 * Off under the test harness (USERMOD_HARNESS). mods.json settings ("lan-monitor"):
 *   port (9640), host ("0.0.0.0" = every interface; "127.0.0.1" = this PC only), token ("" = open; otherwise
 *   every request needs ?t=<token>), camera ("overall" | "topview")
 */
import * as http from "node:http";
import * as os from "node:os";

interface Settings {
  port: number;
  host: string;
  token: string;
  camera: "overall" | "topview";
}
interface StreamEvent {
  type?: string;
  base64?: string;
}
const isStreamEvent = (value: unknown): value is StreamEvent => typeof value === "object" && value !== null;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nest Studio monitor</title>
<style>
body{margin:0;background:#111;color:#eee;font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0 0 12px;display:flex;justify-content:space-between;align-items:center}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;background:#444;font-size:13px}
.pill.running{background:#166534}.pill.paused{background:#8a5a00}.pill.alarm{background:#9b1c1c}
.bar{height:10px;background:#333;border-radius:5px;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:#22c55e;width:0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:12px 0}dt{color:#999}dd{margin:0}
img{width:100%;border-radius:10px;background:#000;min-height:120px}
small{color:#888}
</style></head><body><main>
<h1>Nest Studio <span id="status" class="pill">connecting…</span></h1>
<div id="job">—</div>
<div class="bar"><i id="bar"></i></div>
<dl>
<dt>Line</dt><dd id="line">—</dd>
<dt>Elapsed</dt><dd id="elapsed">—</dd>
<dt>ETA</dt><dd id="eta">—</dd>
<dt>Feed / spindle</dt><dd id="fs">—</dd>
<dt>Position</dt><dd id="pos">—</dd>
</dl>
<img id="cam" alt="camera">
<p><small id="foot"></small></p>
</main>
<script>
const q = location.search;
const fmt = (s) => { if (s == null) return "—"; s = Math.round(s); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), x = s%60; return (h? h+"h " : "") + (h||m ? m+"m " : "") + x+"s"; };
const el = (id) => document.getElementById(id);
async function tick(){
  try {
    const r = await fetch("/api/status" + q, { cache: "no-store" });
    const d = await r.json();
    const s = d.state;
    el("status").textContent = s ? (s.status || s.phase) : "no machine-state mod";
    el("status").className = "pill " + (s ? s.phase : "");
    el("job").textContent = s && s.job && s.job.fileName ? s.job.fileName : "no program";
    el("bar").style.width = s && s.progress != null ? Math.round(s.progress*100) + "%" : "0";
    el("line").textContent = s && s.line != null ? s.line + (s.job && s.job.lines ? " / " + s.job.lines : "") : "—";
    el("elapsed").textContent = s ? fmt(s.elapsedSeconds) : "—";
    el("eta").textContent = s ? fmt(s.etaSeconds) : "—";
    el("fs").textContent = s && (s.feed != null || s.spindle != null) ? (s.feed ?? "—") + " mm/min · " + (s.spindle ?? "—") + " rpm" : "—";
    el("pos").textContent = s && s.wpos ? "X " + s.wpos.x + "  Y " + s.wpos.y + "  Z " + s.wpos.z : "—";
    el("foot").textContent = d.host + " · " + new Date(d.time).toLocaleTimeString() + (d.camera ? "" : " · no camera frame yet");
    if (d.camera) el("cam").src = "/api/camera.jpg" + q + (q ? "&" : "?") + "ts=" + Date.now();
  } catch (e) { el("status").textContent = "offline"; el("status").className = "pill"; }
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

const mod: Usermod.MainMod<Settings> = {
  description: "Read-only LAN status page with camera frame (monitor:status)",
  activate(api) {
    const s: Settings = { port: 9640, host: "0.0.0.0", token: "", camera: "overall", ...api.settings };
    const port = Number.isInteger(s.port) && s.port > 0 ? s.port : 9640;
    let frame: Buffer | null = null;
    let frameAt = 0;
    const wanted = s.camera === "topview" ? "topview_image" : "overall_image";
    api.electron.app.on("web-contents-created", (_event, contents) => {
      const original = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === "device:stream-event" && isStreamEvent(args[0]) && args[0].type === wanted && typeof args[0].base64 === "string") {
          try {
            frame = Buffer.from(args[0].base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
            frameAt = Date.now();
          } catch {
            /* ignore a bad frame */
          }
        }
        return original(channel, ...args);
      };
    });

    const urls = (): string[] => {
      const out: string[] = [];
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}/${s.token ? `?t=${encodeURIComponent(s.token)}` : ""}  (${name})`);
      }
      if (s.host === "127.0.0.1" || !out.length) out.unshift(`http://127.0.0.1:${port}/${s.token ? `?t=${encodeURIComponent(s.token)}` : ""}`);
      return out;
    };
    let listening = false;
    let lastError = "";
    let requests = 0;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (s.token && url.searchParams.get("t") !== s.token) {
        res.writeHead(403, { "content-type": "text/plain" }).end("token required");
        return;
      }
      requests += 1;
      res.setHeader("cache-control", "no-store");
      if (url.pathname === "/api/status") {
        let state: Usermod.MachineState | null = null;
        try {
          state = await api.call<Usermod.MachineState>("machine:state");
        } catch {
          state = null;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state, host: os.hostname(), time: new Date().toISOString(), camera: frame !== null, cameraAt: frameAt || null }));
      } else if (url.pathname === "/api/camera.jpg") {
        if (!frame) res.writeHead(404).end();
        else res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(frame.length) }).end(frame);
      } else if (url.pathname === "/") res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      else res.writeHead(404).end();
    });
    server.on("error", (error: NodeJS.ErrnoException) => {
      lastError = error.code === "EADDRINUSE" ? `port ${port} is in use` : error.message;
      api.warn(`server error: ${lastError}`);
      listening = false;
    });
    if (process.env.USERMOD_HARNESS) api.log("harness run: not listening");
    else
      server.listen(port, s.host, () => {
        listening = true;
        api.log(`listening on ${s.host}:${port}${s.token ? " (token required)" : ""}`);
      });
    server.unref();

    api.handle("monitor:status", () => ({ listening, port, host: s.host, token: s.token !== "", urls: urls(), requests, cameraAt: frameAt || null, error: lastError || null }));
  }
};

export = mod;
