/*
 * Jobs (main): one view of the machine's job lifecycle, built on the machine-state mod's in-process events
 * (api.events.on("machine-state")) and the loader's gcode-sent event. It replaces job-notifier and job-history:
 *   - notifications: desktop toast (and optional webhook POST) when a run finishes, the machine alarms or the
 *     job pauses; runs shorter than minRunSeconds are ignored, Idle must persist settleSeconds to count as done
 *   - history: one record per run (program, tools, duration, last line, outcome) in data/jobs/history.json,
 *     CSV export, folder opener
 * Needs the machine-state mod (it does the status parsing once for everyone).
 *
 * IPC: jobs:status, jobs:test, jobs:reload-settings, jobs:list, jobs:clear, jobs:export-csv, jobs:open.
 * Events to the UI: jobs:event { kind, title, body, at }, jobs:changed { id, outcome }.
 * mods.json settings ("jobs"): notifyComplete (true), notifyError (true), notifyPause (true), minRunSeconds (20),
 *   settleSeconds (3), webhookUrl (""), silent (false), keep (500)
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Settings {
  notifyComplete: boolean;
  notifyError: boolean;
  notifyPause: boolean;
  minRunSeconds: number;
  settleSeconds: number;
  webhookUrl: string;
  silent: boolean;
  keep: number;
}
type Outcome = "running" | "completed" | "stopped" | "alarm" | "replaced" | "unknown";
interface RunRecord {
  id: string;
  fileName: string;
  startedAt: number;
  endedAt: number | null;
  durationSeconds: number | null;
  estimatedSeconds: number | null;
  lines: number;
  lastLine: number | null;
  tools: string[];
  outcome: Outcome;
  note: string;
}
interface Status {
  phase: Usermod.MachinePhase;
  fileName: string | null;
  totalLines: number | null;
  lastLine: number | null;
  lastStatus: string | null;
  lastEvent: string | null;
  lastEventAt: number | null;
  elapsedSeconds: number;
  connected: boolean;
  settings: Settings;
}
const isRunRecord = (v: unknown): v is RunRecord => typeof v === "object" && v !== null && typeof (v as RunRecord).id === "string" && typeof (v as RunRecord).startedAt === "number";

const mod: Usermod.MainMod<Settings> = {
  description: "Job notifications (toast, webhook) and run history (jobs:*)",
  activate(api) {
    const { Notification } = api.electron;
    const read = (): Settings => {
      const s = api.settings;
      return {
        notifyComplete: s.notifyComplete !== false,
        notifyError: s.notifyError !== false,
        notifyPause: s.notifyPause !== false,
        minRunSeconds: Number(s.minRunSeconds ?? 20),
        settleSeconds: Number(s.settleSeconds ?? 3),
        webhookUrl: typeof s.webhookUrl === "string" ? s.webhookUrl : "",
        silent: s.silent === true,
        keep: Math.max(10, Number(s.keep ?? 500))
      };
    };
    let settings = read();

    /* ------------------------------------------------------------ history */
    const dir = path.join(api.dataDir, "jobs");
    const file = path.join(dir, "history.json");
    let records: RunRecord[] = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) records = parsed.filter(isRunRecord);
    } catch {
      /* no history yet */
    }
    for (const r of records) if (r.outcome === "running") r.outcome = "unknown"; // left open by a crash or quit
    const save = (): void => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (records.length > settings.keep) records = records.slice(records.length - settings.keep);
        fs.writeFileSync(file, JSON.stringify(records, null, 2));
      } catch (error) {
        api.warn(`could not save history: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    /* -------------------------------------------------------------- state */
    let current: RunRecord | null = null;
    let phase: Usermod.MachinePhase = "idle";
    let lastStatus: string | null = null;
    let lastLine: number | null = null;
    let connected = false;
    let lastEvent: string | null = null;
    let lastEventAt: number | null = null;
    let settleTimer: NodeJS.Timeout | null = null;
    const startedAt = (): number | null => current?.startedAt ?? null;
    const elapsed = (): number => (startedAt() ? (Date.now() - startedAt()!) / 1000 : 0);
    const fmt = (seconds: number): string => {
      const s = Math.round(seconds);
      return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    };

    async function notify(kind: "complete" | "error" | "pause" | "test", title: string, body: string): Promise<void> {
      lastEvent = `${kind}: ${title}`;
      lastEventAt = Date.now();
      api.log(`${kind}: ${title} - ${body}`);
      try {
        if (Notification.isSupported()) new Notification({ title, body, silent: settings.silent }).show();
      } catch (error) {
        api.warn(`notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (settings.webhookUrl) {
        try {
          await fetch(settings.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source: "nest-studio-usermods", kind, title, body, fileName: current?.fileName ?? null, elapsedSeconds: Math.round(elapsed()), line: lastLine, totalLines: current?.lines ?? null, at: new Date().toISOString() })
          });
        } catch (error) {
          api.warn(`webhook failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      api.send("jobs:event", { kind, title, body, at: lastEventAt });
    }
    const finish = (outcome: Outcome, note = ""): void => {
      if (!current) return;
      current.endedAt = Date.now();
      current.durationSeconds = Math.round((current.endedAt - current.startedAt) / 1000);
      current.outcome = outcome;
      current.note = note;
      current.lastLine = lastLine;
      api.log(`${current.fileName}: ${outcome} after ${current.durationSeconds}s`);
      api.send("jobs:changed", { id: current.id, outcome });
      current = null;
      save();
    };

    api.events.on("gcode-sent", (p) => {
      finish("replaced", "another program was sent");
      const tools = [...new Set((p.gcode.match(/(?:^|[^A-Za-z])T(\d+)/gm) ?? []).map((m) => `T${m.replace(/\D/g, "")}`))];
      current = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, fileName: p.fileName ?? "program.nc", startedAt: Date.now(), endedAt: null, durationSeconds: null, estimatedSeconds: p.runTimeSeconds ?? null, lines: p.lines, lastLine: null, tools, outcome: "running", note: "" };
      lastLine = null;
      phase = "running";
      records.push(current);
      save();
      api.send("jobs:changed", { id: current.id, outcome: "running" });
      api.log(`job sent: ${current.fileName} (${p.lines} lines)`);
    });

    api.events.on("machine-state", (s) => {
      connected = s.connected;
      lastStatus = s.status;
      if (s.line !== null && s.line > 0) lastLine = s.line;
      if (s.phase === "alarm") {
        if (phase !== "alarm") {
          if (settings.notifyError) void notify("error", "Nest Studio: machine alarm", `${current?.fileName ?? "Machine"}${startedAt() ? ` after ${fmt(elapsed())}` : ""}${s.alarm ? ` - ${s.alarm}` : ""}`);
          finish("alarm", s.alarm ?? "alarm");
          phase = "alarm";
        }
        return;
      }
      if (s.phase === "running") {
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        if (phase !== "running" && !current && (phase === "idle" || phase === "alarm")) {
          // A run started without the app sending G-code (small-screen start): track it anyway.
          current = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, fileName: s.job.fileName ?? "(started on the machine)", startedAt: Date.now(), endedAt: null, durationSeconds: null, estimatedSeconds: s.job.runTimeSeconds, lines: s.job.lines ?? 0, lastLine: null, tools: s.job.toolChanges.flatMap((c) => (c.tool ? [c.tool] : [])), outcome: "running", note: "" };
          records.push(current);
        }
        phase = "running";
        return;
      }
      if (s.phase === "paused") {
        if (phase === "running" && settings.notifyPause) void notify("pause", "Nest Studio: job paused", `${current?.fileName ?? "Program"} held at line ${lastLine ?? "?"} after ${fmt(elapsed())}`);
        phase = "paused";
        return;
      }
      if (s.phase === "idle" && (phase === "running" || phase === "paused") && !settleTimer) {
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (phase !== "running" && phase !== "paused") return;
          const seconds = elapsed();
          phase = "idle";
          const progress = current?.lines && lastLine ? lastLine / current.lines : null;
          if (progress !== null && progress < 0.97) finish("stopped", `ended at line ${lastLine} of ${current?.lines}`);
          else finish("completed");
          if (seconds >= settings.minRunSeconds && settings.notifyComplete) void notify("complete", "Nest Studio: job finished", `${records[records.length - 1]?.fileName ?? "Program"} completed in ${fmt(seconds)}`);
        }, settings.settleSeconds * 1000);
        settleTimer.unref();
      }
      if (s.phase === "disconnected" && current && Date.now() - current.startedAt > 15000) finish("unknown", "connection lost");
    });

    api.handle("jobs:status", (): Status => ({ phase, fileName: current?.fileName ?? null, totalLines: current?.lines ?? null, lastLine, lastStatus, lastEvent, lastEventAt, elapsedSeconds: Math.round(elapsed()), connected, settings }));
    api.handle("jobs:test", () => notify("test", "Nest Studio: test notification", "Notifications are working."));
    api.handle("jobs:reload-settings", () => {
      settings = read();
      return settings;
    });
    api.handle("jobs:list", () => records.slice().reverse());
    api.handle("jobs:clear", () => {
      records = current ? [current] : [];
      save();
      return records.length;
    });
    api.handle("jobs:export-csv", () => {
      const esc = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = [["started", "file", "outcome", "duration_s", "estimated_s", "lines", "last_line", "tools", "note"].join(",")];
      for (const r of records) rows.push([new Date(r.startedAt).toISOString(), r.fileName, r.outcome, r.durationSeconds ?? "", r.estimatedSeconds ?? "", r.lines, r.lastLine ?? "", r.tools.join(" "), r.note].map(esc).join(","));
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, "history.csv");
      fs.writeFileSync(out, `${rows.join("\n")}\n`, "utf8");
      return out;
    });
    api.handle("jobs:open", () => {
      fs.mkdirSync(dir, { recursive: true });
      return api.electron.shell.openPath(dir);
    });
    api.log(`jobs active (${records.length} record(s))`);
  }
};

export = mod;
