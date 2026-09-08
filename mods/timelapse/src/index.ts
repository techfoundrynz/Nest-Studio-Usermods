/*
 * Camera timelapse (main): the machine streams camera frames to the app as base64 events
 * (overall_image / topview_image). While a job runs, save one frame every N seconds to
 * data/timelapse/<program>-<start>/NNNN.jpg.
 *
 * mods.json settings ("timelapse"):
 *   intervalSeconds (default 30), source ("overall" | "topview", default overall),
 *   onlyWhileRunning (default true), maxFramesPerJob (default 2000)
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface StreamEvent {
  type?: string;
  base64?: string;
  payload?: { status?: string };
}
const isStreamEvent = (value: unknown): value is StreamEvent => typeof value === "object" && value !== null;

const mod: Usermod.MainMod<{ intervalSeconds: number; source: string; onlyWhileRunning: boolean; maxFramesPerJob: number }> = {
  description: "Saves camera frames to data/timelapse while a job runs",
  activate(api) {
    const interval = Math.max(2, Number(api.settings.intervalSeconds ?? 30)) * 1000;
    const wanted = api.settings.source === "topview" ? "topview_image" : "overall_image";
    const onlyWhileRunning = api.settings.onlyWhileRunning !== false;
    const maxFrames = Number(api.settings.maxFramesPerJob ?? 2000);
    let running = false;
    let jobDir: string | null = null;
    let frames = 0;
    let lastSaved = 0;

    const startJob = (name: string): void => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      jobDir = path.join(api.dataDir, "timelapse", `${name.replace(/[^\w.-]+/g, "_")}-${stamp}`);
      frames = 0;
      lastSaved = 0;
    };
    api.events.on("gcode-sent", (p) => startJob(p.fileName ?? "program"));

    const onEvent = (event: StreamEvent): void => {
      if (event.type === "machine_status") {
        const s = String(event.payload?.status ?? "");
        const now = s === "Run" || s === "Jog" || s === "Home";
        if (now && !running && !jobDir) startJob("job");
        running = now || s.startsWith("Hold") || s.startsWith("Door");
        if (s === "Idle" || s === "Ready") {
          if (running && frames) api.log(`timelapse finished: ${frames} frame(s) in ${jobDir}`);
          running = false;
          jobDir = null;
        }
        return;
      }
      if (event.type !== wanted || typeof event.base64 !== "string") return;
      if (onlyWhileRunning && !running) return;
      const now = Date.now();
      if (now - lastSaved < interval || frames >= maxFrames) return;
      const dir = jobDir ?? path.join(api.dataDir, "timelapse", "unattributed");
      try {
        fs.mkdirSync(dir, { recursive: true });
        const data = event.base64.replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(path.join(dir, `${String(frames + 1).padStart(4, "0")}.jpg`), Buffer.from(data, "base64"));
        frames += 1;
        lastSaved = now;
      } catch (error) {
        api.warn(`frame save failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    api.electron.app.on("web-contents-created", (_event, contents) => {
      const original = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === "device:stream-event") {
          try {
            if (isStreamEvent(args[0])) onEvent(args[0]);
          } catch (error) {
            api.warn(`event failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return original(channel, ...args);
      };
    });
    api.handle("timelapse:status", () => ({ running, jobDir, frames }));
    api.handle("timelapse:open", () => api.electron.shell.openPath(path.join(api.dataDir, "timelapse")));
    api.log(`timelapse active (${wanted}, every ${interval / 1000}s)`);
  }
};

export = mod;
