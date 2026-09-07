/*
 * Machine state (main): one place that watches the machine status stream the app forwards to its renderer
 * plus the loader's gcode-sent event, and turns them into a normalised state other mods consume:
 *   usermod.on("machine:state", state)       broadcast (throttled) to UI mods
 *   usermod.invoke("machine:state")          current state on demand
 *   usermod.invoke("machine:send", text)     send a text command through the app's device channel is NOT
 *                                            possible from main; UI mods use window.api.device.sendMessage.
 * Optionally appends every console line to data/console/<date>.log.
 *
 * mods.json settings ("machine-state"): logConsole (default false), broadcastMs (default 500)
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Phase = "idle" | "running" | "paused" | "alarm" | "disconnected";
interface ToolChange {
  line: number;
  tool: string | null;
}
interface Job {
  fileName: string | null;
  lines: number | null;
  runTimeSeconds: number | null;
  startedAt: number | null;
  toolChanges: ToolChange[];
}
interface MachineState {
  connected: boolean;
  status: string | null;
  alarm: string | null;
  phase: Phase;
  line: number | null;
  job: Job;
  elapsedSeconds: number;
  progress: number | null;
  etaSeconds: number | null;
  updatedAt: number;
}
interface StreamEvent {
  type?: string;
  payload?: { status?: string; codeStatus?: string; codeStatusDetail?: string; Ln?: number };
  phase?: string;
  line?: string;
}

const mod: Usermod.MainMod<{ logConsole: boolean; broadcastMs: number }> = {
  description: "Normalised machine status / progress / ETA for other mods (machine:state)",
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
      updatedAt: Date.now()
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
        return;
      }
      if (event.type !== "machine_status" || !event.payload) return;
      const s = String(event.payload.status ?? "").trim();
      state.connected = true;
      state.status = s;
      if (typeof event.payload.Ln === "number" && event.payload.Ln > 0) state.line = event.payload.Ln;
      if (s === "Alarm") {
        state.phase = "alarm";
        state.alarm = [event.payload.codeStatus, event.payload.codeStatusDetail].filter(Boolean).join(" ") || "Alarm";
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
            onEvent((args[0] ?? {}) as StreamEvent);
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
