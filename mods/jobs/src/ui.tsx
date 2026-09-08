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
            { key: "keep", label: "History records to keep", type: "number", min: 10, step: 50 }
          ]}
          onSaved={() => call("jobs:reload-settings")}
        />
      </>
    );
  }

  ui.toolbar.addButton({
    id: "jobs",
    title: "Jobs: run history and notifications",
    icon: () => ui.icons.svg("M9 2h6v2h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3V2zm2 2v1h2V4h-2zM7 6v14h10V6h-1.5v1.5h-7V6H7zm1.5 5H16v1.5H8.5V11zm0 4H16v1.5H8.5V15z"),
    order: 30,
    onClick: () => {
      ui.react.modal("Jobs", <Panel />, { width: 820 });
    }
  });
})();
