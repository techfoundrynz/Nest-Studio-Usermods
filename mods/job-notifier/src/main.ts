/*
 * Job notifier (main process). Watches the machine status stream the app forwards to its renderer
 * (channel "device:stream-event", type "machine_status") and the loader's gcode-sent event, derives job
 * start / complete / error / pause transitions, and raises Windows notifications and an optional webhook.
 *
 * mods.json settings ("job-notifier"):
 *   notifyComplete  toast when a job finishes                         (default true)
 *   notifyError     toast on Alarm                                    (default true)
 *   notifyPause     toast when the machine holds / door opens         (default true)
 *   minRunSeconds   ignore runs shorter than this (jogs, probing)     (default 20)
 *   settleSeconds   Idle must persist this long to count as finished  (default 3)
 *   webhookUrl      POST a JSON event here as well                    (default "")
 *   silent          notifications without sound                      (default false)
 */
type Phase = "idle" | "running" | "paused" | "alarm";
interface Settings {
  notifyComplete: boolean;
  notifyError: boolean;
  notifyPause: boolean;
  minRunSeconds: number;
  settleSeconds: number;
  webhookUrl: string;
  silent: boolean;
}
interface MachineStatus {
  status?: string;
  codeStatus?: string;
  codeStatusDetail?: string;
  Ln?: number;
}
interface StreamEvent {
  type?: string;
  payload?: MachineStatus;
  phase?: string;
}
const isStreamEvent = (value: unknown): value is StreamEvent => typeof value === "object" && value !== null;
interface JobState {
  phase: Phase;
  fileName: string | null;
  totalLines: number | null;
  startedAt: number | null;
  lastLine: number | null;
  lastStatus: string | null;
  lastEvent: string | null;
  lastEventAt: number | null;
  connected: boolean;
}

const mod: Usermod.MainMod<Settings> = {
  description: "Windows notifications and optional webhook when a machine job completes, errors or pauses",
  activate(api) {
    const { Notification, app } = api.electron;
    let settings: Settings = current();
    function current(): Settings {
      const s = api.settings;
      return {
        notifyComplete: s.notifyComplete !== false,
        notifyError: s.notifyError !== false,
        notifyPause: s.notifyPause !== false,
        minRunSeconds: Number(s.minRunSeconds ?? 20),
        settleSeconds: Number(s.settleSeconds ?? 3),
        webhookUrl: typeof s.webhookUrl === "string" ? s.webhookUrl : "",
        silent: s.silent === true
      };
    }
    const job: JobState = { phase: "idle", fileName: null, totalLines: null, startedAt: null, lastLine: null, lastStatus: null, lastEvent: null, lastEventAt: null, connected: false };
    let settleTimer: NodeJS.Timeout | null = null;

    const elapsed = (): number => (job.startedAt ? (Date.now() - job.startedAt) / 1000 : 0);
    const fmt = (seconds: number): string => {
      const s = Math.round(seconds);
      return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    };

    async function notify(kind: "complete" | "error" | "pause" | "test", title: string, body: string): Promise<void> {
      job.lastEvent = `${kind}: ${title}`;
      job.lastEventAt = Date.now();
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
            body: JSON.stringify({ source: "nest-studio-usermods", kind, title, body, fileName: job.fileName, elapsedSeconds: Math.round(elapsed()), line: job.lastLine, totalLines: job.totalLines, at: new Date().toISOString() })
          });
        } catch (error) {
          api.warn(`webhook failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      api.send("job-notifier:event", { kind, title, body, at: job.lastEventAt });
    }

    function onStatus(status: MachineStatus): void {
      const state = String(status.status ?? "").trim();
      job.lastStatus = state;
      if (typeof status.Ln === "number" && status.Ln > 0) job.lastLine = status.Ln;
      const running = state === "Run" || state === "Jog" || state === "Home";
      const paused = state === "Hold" || state === "Door" || state.startsWith("Hold") || state.startsWith("Door");
      const idle = state === "Idle" || state === "Ready";

      if (state === "Alarm") {
        if (job.phase !== "alarm") {
          const detail = [status.codeStatus, status.codeStatusDetail].filter(Boolean).join(" ");
          if (settings.notifyError) void notify("error", "Nest Studio: machine alarm", `${job.fileName ?? "Machine"}${job.startedAt ? ` after ${fmt(elapsed())}` : ""}${detail ? ` - ${detail}` : ""}`);
          job.phase = "alarm";
        }
        return;
      }
      if (running) {
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        if (job.phase !== "running") {
          if (job.phase === "idle" || job.phase === "alarm") job.startedAt = Date.now();
          job.phase = "running";
        }
        return;
      }
      if (paused) {
        if (job.phase === "running") {
          job.phase = "paused";
          if (settings.notifyPause) void notify("pause", "Nest Studio: job paused", `${job.fileName ?? "Program"} held at line ${job.lastLine ?? "?"} after ${fmt(elapsed())}`);
        }
        return;
      }
      if (idle && (job.phase === "running" || job.phase === "paused") && !settleTimer) {
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (job.phase !== "running" && job.phase !== "paused") return;
          const seconds = elapsed();
          job.phase = "idle";
          if (seconds >= settings.minRunSeconds && settings.notifyComplete) {
            void notify("complete", "Nest Studio: job finished", `${job.fileName ?? "Program"} completed in ${fmt(seconds)}${job.totalLines ? ` (${job.totalLines} lines)` : ""}`);
          }
          job.startedAt = null;
        }, settings.settleSeconds * 1000);
      }
    }

    api.events.on("gcode-sent", (payload) => {
      job.fileName = payload.fileName ?? "program.nc";
      job.totalLines = payload.lines;
      job.startedAt = Date.now();
      job.lastLine = null;
      job.phase = "running";
      api.log(`job sent: ${job.fileName} (${payload.lines} lines)`);
    });

    // The device module forwards machine events to the renderer with webContents.send; observe them there.
    app.on("web-contents-created", (_event, contents) => {
      const original = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === "device:stream-event") {
          const event = isStreamEvent(args[0]) ? args[0] : undefined;
          try {
            if (event?.type === "machine_status" && event.payload) onStatus(event.payload);
            else if (event?.type === "connection") job.connected = event.phase === "reconnected" || event.phase === "connected";
          } catch (error) {
            api.warn(`status handling failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return original(channel, ...args);
      };
    });

    api.handle("notifier:status", () => ({ ...job, settings, elapsedSeconds: Math.round(elapsed()) }));
    api.handle("notifier:test", () => notify("test", "Nest Studio: test notification", "Notifications are working."));
    api.handle("notifier:reload-settings", () => {
      settings = current();
      return settings;
    });
    api.log("job notifier active");
  }
};

export = mod;
