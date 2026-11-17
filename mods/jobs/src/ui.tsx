/*
 * Jobs (UI): "Jobs…" in the MODS menu shows the current run, the history table with totals and CSV export,
 * a test-notification button and the notification settings. Also mirrors notifications as in-app toasts.
 */
(function jobsUi(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Section, KV, Row, Button, Sub, SettingsForm, Loading, Err, useInvoke, useEvent } = ui.react;
  rt.register({ name: "jobs", version: "0.1.0" });

  rt.addStyle(
    `.usermod-jobs{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
     .usermod-jobs th,.usermod-jobs td{text-align:left;padding:4px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap}
     .usermod-jobs th{font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.05em}
     .usermod-jobs td.num{text-align:right}
     .usermod-jobs .completed{color:#166534}.usermod-jobs .alarm{color:#b3261e}.usermod-jobs .stopped,.usermod-jobs .replaced{color:#8a5a00}.usermod-jobs .running{color:#0f766e;font-weight:600}
     html[data-theme=dark] .usermod-jobs th,html[data-theme=dark] .usermod-jobs td{border-color:#3a3a3a}
     html[data-theme=dark] .usermod-jobs .completed{color:#4ade80}html[data-theme=dark] .usermod-jobs .alarm{color:#f87171}`,
    "jobs"
  );

  interface Status {
    phase: string;
    fileName: string | null;
    totalLines: number | null;
    lastLine: number | null;
    lastStatus: string | null;
    lastEvent: string | null;
    lastEventAt: number | null;
    elapsedSeconds: number;
    connected: boolean;
  }
  interface Job {
    id: string;
    fileName: string;
    startedAt: number;
    durationSeconds: number | null;
    estimatedSeconds: number | null;
    lines: number;
    lastLine: number | null;
    tools: string[];
    outcome: string;
    note: string;
  }
  const call = async <T,>(channel: string): Promise<T> => {
    const r = await window.usermod.invoke<T>(channel);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };
  window.usermod.on<{ kind: string; title: string; body: string }>("jobs:event", (e) => {
    rt.toast(`${e.title}: ${e.body}`, { kind: e.kind === "error" ? "error" : e.kind === "pause" ? "warn" : "success", duration: 6000 });
  });
  let refreshPillSettings: () => Promise<void>;

  function Panel(): React.JSX.Element {
    const status = useInvoke<Status>("jobs:status");
    const jobs = useInvoke<Job[]>("jobs:list");
    useEvent("jobs:changed", () => {
      void jobs.refresh();
      void status.refresh();
    });
    React.useEffect(() => {
      const t = setInterval(() => void status.refresh(), 2000);
      return () => clearInterval(t);
    }, [status.refresh]);
    if (status.error || jobs.error) return <Err>{status.error ?? jobs.error}</Err>;
    if (!status.data || !jobs.data) return <Loading />;
    const s = status.data;
    const list = jobs.data;
    const finished = list.filter((j) => j.durationSeconds !== null);
    const total = finished.reduce((sum, j) => sum + (j.durationSeconds ?? 0), 0);
    return (
      <>
        <Section title="Current job">
          <KV
            pairs={[
              ["Phase", s.phase],
              ["Program", s.fileName ?? "—"],
              ["Progress", s.lastLine ? `line ${s.lastLine}${s.totalLines ? ` of ${s.totalLines}` : ""}` : "—"],
              ["Elapsed", s.elapsedSeconds ? rt.formatDuration(s.elapsedSeconds) : "—"],
              ["Machine status", s.lastStatus ?? (s.connected ? "—" : "disconnected")],
              ["Last notification", s.lastEvent ? `${s.lastEvent} (${s.lastEventAt ? new Date(s.lastEventAt).toLocaleTimeString() : ""})` : "—"]
            ]}
          />
          <Row>
            <Button label="Send test notification" primary onClick={() => call("jobs:test").then(() => rt.toast("Test sent", { kind: "success" }))} />
          </Row>
        </Section>
        <Section title="History">
          <KV
            pairs={[
              ["Runs", `${list.length} (${list.filter((j) => j.outcome === "completed").length} completed, ${list.filter((j) => j.outcome === "alarm").length} alarms)`],
              ["Machine time", rt.formatDuration(total)],
              ["Average run", finished.length ? rt.formatDuration(Math.round(total / finished.length)) : "—"]
            ]}
          />
          <Row>
            <Button
              label="Export CSV"
              onClick={async () => {
                const p = await call<string>("jobs:export-csv");
                rt.toast(`Written ${p}`, { kind: "success", duration: 5000 });
              }}
            />
            <Button label="Open folder" onClick={() => call("jobs:open")} />
            <Button
              label="Clear history"
              onClick={async () => {
                await call("jobs:clear");
                await jobs.refresh();
                rt.toast("History cleared");
              }}
            />
          </Row>
          {list.length ? (
            <div style={{ overflow: "auto", maxHeight: "40vh" }}>
              <table className="usermod-jobs">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Program</th>
                    <th>Outcome</th>
                    <th>Duration</th>
                    <th>Estimate</th>
                    <th>Progress</th>
                    <th>Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((j) => (
                    <tr key={j.id} title={j.note}>
                      <td>{new Date(j.startedAt).toLocaleString()}</td>
                      <td>{j.fileName}</td>
                      <td className={j.outcome}>{j.outcome}</td>
                      <td className="num">{j.durationSeconds === null ? "…" : rt.formatDuration(j.durationSeconds)}</td>
                      <td className="num">{j.estimatedSeconds ? rt.formatDuration(j.estimatedSeconds) : "—"}</td>
                      <td className="num">{j.lastLine !== null && j.lines ? `${Math.min(100, Math.round((j.lastLine / j.lines) * 100))}%` : "—"}</td>
                      <td>{j.tools.join(" ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Sub>No runs recorded yet. Send a program to the machine.</Sub>
          )}
        </Section>
        <SettingsForm
          modName="jobs"
          title="Notifications"
          reloadPostprocessors={false}
          fields={[
            { key: "notifyComplete", label: "Notify when a job finishes", type: "boolean" },
            { key: "notifyError", label: "Notify on machine alarm", type: "boolean" },
            { key: "notifyPause", label: "Notify when the job pauses (hold / door)", type: "boolean" },
            { key: "minRunSeconds", label: "Ignore runs shorter than (seconds)", type: "number", min: 0, step: 5 },
            { key: "settleSeconds", label: "Idle time before a job counts as finished (seconds)", type: "number", min: 1, step: 1 },
            { key: "webhookUrl", label: "Webhook URL (POST JSON, optional)", type: "string", nullable: false, placeholder: "https://…" },
            { key: "silent", label: "Silent notifications (no sound)", type: "boolean" },
            { key: "keep", label: "History records to keep", type: "number", min: 10, step: 50 },
            { key: "hud", label: "Show the status pill on screen", type: "boolean" },
            { key: "hudPosition", label: "Pill position", type: "select", help: "Drag the pill to save a custom position, or choose a preset to reset it.", options: [{ label: "Bottom left", value: "bottom-left" }, { label: "Bottom right", value: "bottom-right" }, { label: "Top right", value: "top-right" }, { label: "Custom (dragged)", value: "custom" }] },
            { key: "hudWhenDisconnected", label: "Show the pill while disconnected", type: "boolean" }
          ]}
          onSaved={async () => {
            await call("jobs:reload-settings");
            await refreshPillSettings();
          }}
        />
      </>
    );
  }

  const openJobs = (): void => void ui.react.modal("Jobs", <Panel />, { width: 820 });
  ui.toolbar.addButton({
    id: "jobs",
    title: "Job information",
    icon: () => ui.icons.svg("M9 2h6v2h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3V2zm2 2v1h2V4h-2zM7 6v14h10V6h-1.5v1.5h-7V6H7zm1.5 5H16v1.5H8.5V11zm0 4H16v1.5H8.5V15z"),
    order: 30,
    onClick: openJobs
  });

  /* Machine-status summary: hidden until settings and valid machine state are available. */
  (function statusPill(): void {
      interface Point { x: number; y: number; }
      let settings: { enabled: boolean; position: string; showWhenDisconnected: boolean; point: Point | null } = {
        enabled: true, position: "bottom-left", showWhenDisconnected: false, point: null
      };
      let settingsLoaded = false;
      let last: Usermod.MachineState | null = null;
      let drag: { pointerId: number; startX: number; startY: number; left: number; top: number; point: Point; moved: boolean } | null = null;
      let ignoreClick = false;
      let savingPosition = Promise.resolve();

      rt.addStyle(
        `#usermod-hud{position:fixed;z-index:2147482500;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:rgba(24,24,24,.88);color:#fff;font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:grab;user-select:none;touch-action:none;backdrop-filter:blur(4px);max-width:calc(100vw - 16px);box-sizing:border-box}
         #usermod-hud[hidden]{display:none!important}
         #usermod-hud[data-dragging]{cursor:grabbing}
         #usermod-hud .label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
         #usermod-hud[data-pos="bottom-left"]{left:16px;bottom:16px}#usermod-hud[data-pos="bottom-right"]{right:16px;bottom:16px}#usermod-hud[data-pos="top-right"]{right:120px;top:52px}
         #usermod-hud .dot{width:8px;height:8px;border-radius:50%;background:#9e9e9e;flex:none}
         #usermod-hud[data-phase="running"] .dot{background:#22c55e;box-shadow:0 0 6px #22c55e}#usermod-hud[data-phase="paused"] .dot{background:#f59e0b}#usermod-hud[data-phase="alarm"] .dot{background:#ef4444}
         #usermod-hud .bar{width:90px;height:4px;border-radius:2px;background:rgba(255,255,255,.2);overflow:hidden}#usermod-hud .bar i{display:block;height:100%;background:#22c55e;width:0}
         #usermod-hud .muted{opacity:.7}`,
        "status-hud"
      );
      const dot = rt.el("span", { class: "dot" });
      const text = rt.el("span", { class: "label" });
      const fill = rt.el("i");
      const bar = rt.el("span", { class: "bar" }, [fill]);
      const eta = rt.el("span", { class: "muted" });
      const hud = rt.el("div", { id: "usermod-hud", "data-pos": settings.position, "data-phase": "disconnected", title: "Machine status (drag to move; click for Jobs)", onClick: () => {
        if (ignoreClick) { ignoreClick = false; return; }
        openJobs();
      } }, [dot, text, bar, eta]);
      hud.hidden = true;
      document.body.appendChild(hud);

      function place(point: Point): Point {
        const bounds = hud.getBoundingClientRect();
        const x = Math.round(Math.max(8, Math.min(point.x, Math.max(8, window.innerWidth - bounds.width - 8))));
        const y = Math.round(Math.max(8, Math.min(point.y, Math.max(8, window.innerHeight - bounds.height - 8))));
        hud.dataset.pos = "custom";
        Object.assign(hud.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
        return { x, y };
      }
      function position(): void {
        hud.dataset.pos = settings.position;
        if (drag?.moved) drag.point = place(drag.point);
        else if (settings.position === "custom" && settings.point) place(settings.point);
        else for (const key of ["left", "top", "right", "bottom"]) hud.style.removeProperty(key);
      }
      const savePosition = (point: Point): void => {
        // Read fresh settings and serialize drops so a slow save cannot overwrite a newer position.
        savingPosition = savingPosition.then(async () => {
          const info = await window.usermod.info();
          if (!info.ok) throw new Error(info.message);
          const mine = info.data.config.settings["jobs"] ?? {};
          const saved = await window.usermod.setSettings("jobs", { ...mine, hudPosition: "custom", hudX: point.x, hudY: point.y });
          if (!saved.ok) throw new Error(saved.message);
        }).catch(error => rt.toast(`Could not save pill position: ${error instanceof Error ? error.message : String(error)}`, { kind: "error" }));
      };
      hud.addEventListener("pointerdown", event => {
        if (hud.hidden || event.button !== 0 || !event.isPrimary) return;
        ignoreClick = false;
        const bounds = hud.getBoundingClientRect();
        drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: bounds.left, top: bounds.top, point: { x: bounds.left, y: bounds.top }, moved: false };
        try { hud.setPointerCapture(event.pointerId); } catch { /* synthetic events or unavailable capture */ }
      });
      hud.addEventListener("pointermove", event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        hud.dataset.dragging = "true";
        drag.point = place({ x: drag.left + dx, y: drag.top + dy });
      });
      const finishDrag = (event: PointerEvent, save: boolean): void => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const gesture = drag;
        drag = null;
        delete hud.dataset.dragging;
        ignoreClick = gesture.moved;
        try { hud.releasePointerCapture(event.pointerId); } catch { /* capture may already be lost */ }
        if (gesture.moved && save) {
          settings = { ...settings, position: "custom", point: gesture.point };
          savePosition(gesture.point);
        }
        position();
      };
      hud.addEventListener("pointerup", event => finishDrag(event, true));
      hud.addEventListener("pointercancel", event => finishDrag(event, false));
      hud.addEventListener("lostpointercapture", event => finishDrag(event, false));
      window.addEventListener("resize", position);

      const fmt = (s: number | null): string => (s === null ? "" : rt.formatDuration(s));
      const capitalise = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
      function render(s: Usermod.MachineState): void {
        last = s;
        hud.dataset.phase = s.phase;
        const visible = settingsLoaded && settings.enabled && (s.connected || settings.showWhenDisconnected);
        hud.hidden = !visible;
        if (!visible) { position(); return; }
        const name = s.job.fileName ?? "";
        const pct = s.progress !== null ? `${Math.round(s.progress * 100)}%` : "";
        // Always name the machine state: an empty pill looks like the mod is broken.
        const state = s.phase === "alarm" ? `Alarm ${s.alarm ?? ""}`.trim() : s.phase === "disconnected" ? "No machine" : capitalise(s.status ?? s.phase) || "No machine data";
        text.textContent = `${state}${name ? ` · ${name}` : ""}${pct ? ` · ${pct}` : ""}`;
        bar.hidden = s.progress === null;
        fill.style.width = `${Math.round((s.progress ?? 0) * 100)}%`;
        eta.textContent = s.phase === "running" && s.etaSeconds ? `${fmt(s.etaSeconds)} left` : s.phase !== "idle" && s.elapsedSeconds ? fmt(s.elapsedSeconds) : "";
        position();
      }
      refreshPillSettings = async () => {
        try {
          const r = await window.usermod.info();
          settingsLoaded = r.ok;
          if (!r.ok) { hud.hidden = true; return; }
          const mine = r.data.config.settings["jobs"] ?? {};
          const point = typeof mine.hudX === "number" && Number.isFinite(mine.hudX) && typeof mine.hudY === "number" && Number.isFinite(mine.hudY)
            ? { x: mine.hudX, y: mine.hudY } : null;
          settings = {
            enabled: mine.hud !== false,
            position: mine.hudPosition === "custom" && point ? "custom" : mine.hudPosition === "bottom-right" || mine.hudPosition === "top-right" ? mine.hudPosition : "bottom-left",
            showWhenDisconnected: mine.hudWhenDisconnected === true,
            point
          };
          if (last) render(last);
        } catch {
          settingsLoaded = false;
          hud.hidden = true;
        }
      };
      const pollState = async (): Promise<void> => {
        try {
          const state = await window.usermod.invoke<Usermod.MachineState>("machine:state");
          if (state.ok) render(state.data);
          else { last = null; hud.hidden = true; }
        } catch {
          last = null;
          hud.hidden = true;
        }
      };
      void refreshPillSettings().then(pollState);
      window.usermod.on<Usermod.MachineState>("machine:state", render);
      setInterval(() => void pollState(), 5000);
  })();
})();
