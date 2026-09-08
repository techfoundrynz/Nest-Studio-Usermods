/*
 * Machine state (main): one place that watches the machine status stream the app forwards to its renderer
 * plus the loader's gcode-sent event, and turns them into a normalised state other mods consume:
 *   usermod.on("machine:state", state)       broadcast (throttled) to UI mods
 *   usermod.invoke("machine:state")          current state on demand (main mods: api.call("machine:state"))
 *   usermod.on("machine:console", line)      error / alarm / probe result console lines only
 *   api.events.on("machine-state", state)    main mods: every frame, in-process
 * Includes machine and work coordinates (MPos / WPos), the active work coordinate system, feed and
 * spindle (FS) and the reported tool when the firmware sends them. Optionally appends every console line
 * to data/console/<date>.log.
 *
 * mods.json settings ("machine-state"): logConsole (default false), broadcastMs (default 500)
 */
import * as fs from "node:fs";
import * as path from "node:path";

type MachineState = Usermod.MachineState;
type ToolChange = Usermod.MachineToolChange;
interface StreamEvent {
  type?: string;
  payload?: { status?: string; codeStatus?: string; codeStatusDetail?: string; Ln?: number; MPos?: string; WPos?: string; G?: number; FS?: string; T?: string };
  phase?: string;
  line?: string;
}
const isStreamEvent = (value: unknown): value is StreamEvent => typeof value === "object" && value !== null;

/** "x,y,z[,a]" → axes, or null when malformed. */
function parseAxes(raw: string | undefined): Usermod.MachineAxes | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  const [x, y, z, a] = parts;
  if (x === undefined || y === undefined || z === undefined || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z, a: a !== undefined && Number.isFinite(a) ? a : 0 };
}
function consoleKind(line: string): Usermod.MachineConsoleLine["kind"] | null {
  if (/^error:|\berror\b/i.test(line)) return "error";
  if (/ALARM/i.test(line)) return "alarm";
  if (/\[PRB:/i.test(line)) return "probe";
  return null;
}

const mod: Usermod.MainMod<{ logConsole: boolean; broadcastMs: number }> = {
  description: "Normalised machine status / position / progress / ETA for other mods (machine:state)",
  activate(api) {
    const broadcastMs = Number(api.settings.broadcastMs ?? 500);
    const logConsole = api.settings.logConsole === true;
    const state: MachineState = {
      connected: false,
      status: null,
      alarm: null,
      phase: "disconnected",
      line: null,
      job: { fileName: null, lines: null, runTimeSeconds: null, startedAt: null, toolChanges: [] },
      elapsedSeconds: 0,
      progress: null,
      etaSeconds: null,
      updatedAt: Date.now(),
      mpos: null,
      wpos: null,
      wcs: null,
      feed: null,
      spindle: null,
      tool: null,
      lastError: null
    };
    let lastBroadcast = 0;
    let pending: NodeJS.Timeout | null = null;

    const compute = (): MachineState => {
      const j = state.job;
      state.elapsedSeconds = j.startedAt && state.phase !== "idle" ? Math.round((Date.now() - j.startedAt) / 1000) : state.elapsedSeconds;
      state.progress = j.lines && state.line ? Math.min(1, state.line / j.lines) : null;
      if (state.phase === "running" && state.progress && state.progress > 0.01) {
        const byRunTime = j.runTimeSeconds ? j.runTimeSeconds * (1 - state.progress) : null;
        const byElapsed = state.elapsedSeconds > 5 ? (state.elapsedSeconds / state.progress) * (1 - state.progress) : null;
        state.etaSeconds = Math.round(byRunTime ?? byElapsed ?? 0) || null;
      } else state.etaSeconds = null;
      state.updatedAt = Date.now();
      return state;
    };
    const broadcast = (force = false): void => {
      api.events.emit("machine-state", compute()); // other main mods (jobs) get every frame, unthrottled
      const now = Date.now();
      if (!force && now - lastBroadcast < broadcastMs) {
        if (!pending) pending = setTimeout(() => broadcast(true), broadcastMs - (now - lastBroadcast));
        return;
      }
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      lastBroadcast = now;
      api.send("machine:state", compute());
    };

    const scanToolChanges = (gcode: string): ToolChange[] => {
      const out: ToolChange[] = [];
      const lines = gcode.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const l = lines[i]!;
        const code = l.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();
        if (/\bM0?6\b/.test(code) || /\(usermod: tool change/i.test(l) || /\bM0?0\b/.test(code)) {
          const tool = /\bT(\d+)/.exec(code)?.[1] ?? /tool change T(\d+)/i.exec(l)?.[1] ?? null;
          out.push({ line: i + 1, tool: tool ? `T${tool}` : null });
        }
      }
      return out;
    };

    api.events.on("gcode-sent", (p) => {
      state.job = { fileName: p.fileName ?? "program.nc", lines: p.lines, runTimeSeconds: p.runTimeSeconds ?? null, startedAt: Date.now(), toolChanges: scanToolChanges(p.gcode) };
      state.line = 0;
      state.phase = "running";
      broadcast(true);
    });

    let consoleStream: fs.WriteStream | null = null;
    let consoleDay = "";
    const logLine = (line: string): void => {
      if (!logConsole) return;
      const day = new Date().toISOString().slice(0, 10);
      if (!consoleStream || consoleDay !== day) {
        consoleStream?.end();
        const dir = path.join(api.dataDir, "console");
        fs.mkdirSync(dir, { recursive: true });
        consoleStream = fs.createWriteStream(path.join(dir, `console-${day}.log`), { flags: "a" });
        consoleDay = day;
      }
      consoleStream.write(`${new Date().toISOString()} ${line}\n`);
    };

    const onEvent = (event: StreamEvent): void => {
      if (event.type === "connection") {
        state.connected = event.phase === "reconnected" || event.phase === "connected";
        if (!state.connected) state.phase = "disconnected";
        broadcast(true);
        return;
      }
      if (event.type === "console_line" && typeof event.line === "string") {
        logLine(event.line);
        if (/connection successful|reconnection successful/i.test(event.line)) state.connected = true;
        const kind = consoleKind(event.line);
        if (kind) {
          const entry: Usermod.MachineConsoleLine = { line: event.line, time: Date.now(), kind };
          if (kind === "error" || kind === "alarm") state.lastError = { line: entry.line, time: entry.time };
          api.send("machine:console", entry);
        }
        return;
      }
      if (event.type !== "machine_status" || !event.payload) return;
      const p = event.payload;
      const s = String(p.status ?? "").trim();
      state.connected = true;
      state.status = s;
      if (typeof p.Ln === "number" && p.Ln > 0) state.line = p.Ln;
      const mpos = parseAxes(p.MPos);
      if (mpos) state.mpos = mpos;
      const wpos = parseAxes(p.WPos);
      if (wpos) state.wpos = wpos;
      if (typeof p.G === "number" && p.G >= 54 && p.G <= 59) state.wcs = p.G;
      if (typeof p.FS === "string") {
        const [f, sp] = p.FS.split(",").map((v) => Number(v.trim()));
        state.feed = f !== undefined && Number.isFinite(f) ? f : state.feed;
        state.spindle = sp !== undefined && Number.isFinite(sp) ? sp : state.spindle;
      }
      if (typeof p.T === "string" && p.T) state.tool = p.T;
      if (s === "Alarm") {
        state.phase = "alarm";
        state.alarm = [p.codeStatus, p.codeStatusDetail].filter(Boolean).join(" ") || "Alarm";
      } else {
        state.alarm = null;
        if (s === "Run" || s === "Jog" || s === "Home") {
          if (state.phase !== "running") {
            if (!state.job.startedAt || state.phase === "idle") state.job.startedAt = Date.now();
            state.phase = "running";
          }
        } else if (s.startsWith("Hold") || s.startsWith("Door")) state.phase = "paused";
        else if (s === "Idle" || s === "Ready") {
          if (state.phase !== "idle") {
            state.phase = "idle";
            state.job.startedAt = null;
          }
        }
      }
      broadcast();
    };

    api.electron.app.on("web-contents-created", (_event, contents) => {
      const original = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === "device:stream-event") {
          try {
            if (isStreamEvent(args[0])) onEvent(args[0]);
          } catch (error) {
            api.warn(`event handling failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return original(channel, ...args);
      };
    });

    api.handle("machine:state", () => compute());
    api.log("machine-state active");
  }
};

export = mod;
