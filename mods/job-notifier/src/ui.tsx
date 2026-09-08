/*
 * Job notifier (UI): "Job notifier…" in the MODS menu shows the tracked job state, a test button and the
 * settings form (React, via the kit); also mirrors notifications as in-app toasts.
 */
(function jobNotifierUi(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Section, KV, Row, Button, SettingsForm, Loading, Err, useInvoke } = ui.react;
  rt.register({ name: "job-notifier", version: "0.2.0" });

  interface Status {
    phase: string;
    fileName: string | null;
    totalLines: number | null;
    lastLine: number | null;
    lastStatus: string | null;
    lastEvent: string | null;
    lastEventAt: number | null;
    elapsedSeconds: number;
  }
  const call = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
    const r = await window.usermod.invoke<T>(channel, ...args);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  window.usermod.on<{ kind: string; title: string; body: string }>("job-notifier:event", (e) => {
    rt.toast(`${e.title}: ${e.body}`, { kind: e.kind === "error" ? "error" : e.kind === "pause" ? "warn" : "success", duration: 6000 });
  });

  function Panel(): React.JSX.Element {
    const { data: status, error, refresh } = useInvoke<Status>("notifier:status");
    React.useEffect(() => {
      const timer = setInterval(() => void refresh(), 2000);
      return () => clearInterval(timer);
    }, [refresh]);
    if (error) return <Err>{error}</Err>;
    if (!status) return <Loading />;
    const at = status.lastEventAt ? new Date(status.lastEventAt).toLocaleTimeString() : "—";
    return (
      <>
        <Section title="Current job">
          <KV
            pairs={[
              ["Phase", status.phase],
              ["Program", status.fileName ?? "—"],
              ["Progress", status.lastLine ? `line ${status.lastLine}${status.totalLines ? ` of ${status.totalLines}` : ""}` : "—"],
              ["Elapsed", status.elapsedSeconds ? rt.formatDuration(status.elapsedSeconds) : "—"],
              ["Machine status", status.lastStatus ?? "—"],
              ["Last notification", status.lastEvent ? `${status.lastEvent} (${at})` : "—"]
            ]}
          />
        </Section>
        <Row>
          <Button label="Send test notification" primary onClick={() => call("notifier:test").then(() => rt.toast("Test sent", { kind: "success" }))} />
        </Row>
        <SettingsForm
          modName="job-notifier"
          title="Settings"
          reloadPostprocessors={false}
          fields={[
            { key: "notifyComplete", label: "Notify when a job finishes", type: "boolean" },
            { key: "notifyError", label: "Notify on machine alarm", type: "boolean" },
            { key: "notifyPause", label: "Notify when the job pauses (hold / door)", type: "boolean" },
            { key: "minRunSeconds", label: "Ignore runs shorter than (seconds)", type: "number", min: 0, step: 5 },
            { key: "settleSeconds", label: "Idle time before a job counts as finished (seconds)", type: "number", min: 1, step: 1 },
            { key: "webhookUrl", label: "Webhook URL (POST JSON, optional)", type: "string", nullable: false, placeholder: "https://…" },
            { key: "silent", label: "Silent notifications (no sound)", type: "boolean" }
          ]}
          onSaved={() => call("notifier:reload-settings")}
        />
      </>
    );
  }

  rt.menu.addAction({
    id: "job-notifier",
    label: "Job notifier…",
    section: "Machine",
    order: 10,
    onClick: ({ close }) => {
      close();
      ui.react.modal("Job notifier", <Panel />, { width: 460 });
    }
  });
})();
