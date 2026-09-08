/*
 * Toolpath modifiers (UI): a toolbar popover listing the enabled post-processors with a switch per processor for
 * "apply when toolpaths are generated". Chosen processors run on every CAM toolpath response (main half), so the
 * Preview tab, the saved project and the export all carry the modified G-code; export and send skip what was
 * already applied. Regenerate the toolpaths in Prepare after changing the selection.
 */
(function toolpathModifiersUi(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, Toggle, KV, Err, Loading, useInfo, useInvoke, useEvent } = ui.react;
  rt.register({ name: "toolpath-modifiers", version: "0.1.0" });

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
  /** Processors that only make sense on a whole program, not on one operation's G-code. */
  const WHOLE_PROGRAM_ONLY = new Set(["program-header", "safe-shutdown", "export-copy", "export-report", "tool-split", "gcode-format"]);

  window.usermod.on<LastRun>("modifiers:applied", (run) => {
    rt.toast(`Toolpath modifiers applied to ${run.endpoint.replace("/api/", "")} (${rt.formatBytes(run.bytesIn)} → ${rt.formatBytes(run.bytesOut)}, ${run.ms} ms)`, { kind: "info", duration: 3500 });
  });

  function Panel(): React.JSX.Element {
    const { data: info, error, refresh } = useInfo();
    const { data: status, refresh: refreshStatus } = useInvoke<Status>("modifiers:status");
    useEvent("modifiers:applied", () => void refreshStatus());
    if (error) return <Err>{error}</Err>;
    if (!info) return <Loading />;
    const settings = info.config.settings["toolpath-modifiers"] ?? {};
    const rawPreview: unknown = settings.preview;
    const preview = new Set(Array.isArray(rawPreview) ? rawPreview.filter((n): n is string => typeof n === "string") : []);
    const save = async (next: Set<string>): Promise<void> => {
      const r = await window.usermod.setSettings("toolpath-modifiers", { ...settings, preview: [...next] });
      if (!r.ok) throw new Error(r.message);
      await refresh();
    };
    const toggle = (name: string, on: boolean): Promise<void> => {
      const next = new Set(preview);
      if (on) next.add(name);
      else next.delete(name);
      return save(next);
    };
    return (
      <>
        <h3>Toolpath modifiers</h3>
        <Sub>Post-processors switched on here run on each toolpath as the CAM generates it, so the Preview tab, the saved project and the export all carry the result. Export and send skip processors that were already applied at generation.</Sub>
        {!info.postprocessors.length ? <Sub>No post-processor mods are enabled (MODS ▸ Enable/disable mods).</Sub> : null}
        {info.postprocessors.map((p) => (
          <Toggle
            key={p.name}
            label={`${p.name} — apply at generation`}
            checked={preview.has(p.name)}
            onChange={(on) => void toggle(p.name, on).catch((e: unknown) => rt.toast(e instanceof Error ? e.message : String(e), { kind: "error" }))}
            help={`${p.description}${WHOLE_PROGRAM_ONLY.has(p.name) ? " (works on whole programs: better left for export)" : ""}`}
          />
        ))}
        <KV
          pairs={[
            ["Interception", status ? (status.intercepting ? <span className="usermod-ok">active</span> : <span className="usermod-err">{status.reason ?? "inactive"}</span>) : "…"],
            ["Toolpaths seen", status ? String(status.count) : "…"],
            ["Last", status?.last ? `${status.last.endpoint} · ${status.last.changed ? "modified" : "unchanged"} · ${status.last.ms} ms${status.last.error ? ` · ${status.last.error}` : ""}` : "—"]
          ]}
        />
        <Sub>Regenerate the toolpaths in Prepare after changing the selection; each CAM response is one operation's G-code, not the whole program.</Sub>
        <Row>
          <Button label="Refresh" onClick={() => Promise.all([refresh(), refreshStatus()]).then(() => undefined)} />
        </Row>
      </>
    );
  }

  ui.toolbar.addButton({
    id: "toolpath-modifiers",
    title: "Toolpath modifiers",
    icon: () => ui.icons.svg("M3 4h18l-7 8.5V20l-4-2v-5.5L3 4zm3.9 2 4.6 5.6.5.6v6.1l.9.5v-6.6l.5-.6L18.1 6H6.9z"),
    order: 34,
    onClick: (button) => {
      ui.react.popover(button, <Panel />, { width: 460 });
    }
  });
})();
