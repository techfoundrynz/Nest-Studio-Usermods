/*
 * Tool-change assistant: when the machine enters Hold near a tool-change line of the running program
 * (M6 / M0 / tool-change-guard markers, as scanned by the machine-state mod), pops a dialog naming the
 * tool (with its library name and diameter when found) and offers Resume (sends the configured cycle-start
 * command, GRBL "~" by default).
 *
 * mods.json settings ("tool-change-assistant"): resumeCommand (default "~"), windowLines (default 3)
 */
(function toolChangeAssistant(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "tool-change-assistant", version: "0.1.0" });

  interface State {
    phase: string;
    line: number | null;
    job: { fileName: string | null; toolChanges: { line: number; tool: string | null }[] };
  }
  let settings = { resumeCommand: "~", windowLines: 3 };
  let shownFor: string | null = null;
  let modal: Usermod.ModalHandle | null = null;

  void window.usermod.info().then((r) => {
    if (!r.ok) return;
    const mine = r.data.config.settings["tool-change-assistant"] ?? {};
    settings = { resumeCommand: typeof mine.resumeCommand === "string" && mine.resumeCommand ? mine.resumeCommand : "~", windowLines: Number(mine.windowLines ?? 3) || 3 };
  });

  async function toolInfo(tool: string | null): Promise<string> {
    if (!tool) return "unknown tool";
    const slot = Number(tool.replace(/^T/i, ""));
    try {
      const store = await window.api.store.read();
      const lib = store.ok ? store.data.toolLibary?.cutLibrarySettings ?? [] : [];
      const t = lib.find((x) => Number(x.slotNum) === slot);
      return t ? `${tool} — ${t.name} (${t.type}, Ø${t.diameter} mm)` : `${tool} (not in tool library)`;
    } catch {
      return tool;
    }
  }
  async function resume(): Promise<void> {
    const send = window.api.device.sendMessage as (m: { type: "text"; payload: string }) => Promise<NestStudio.Result<unknown>>;
    const r = await send({ type: "text", payload: settings.resumeCommand });
    if (!r.ok) throw new Error(r.message ?? r.code ?? "send failed");
    rt.toast("Resume sent", { kind: "success" });
    modal?.close();
    modal = null;
  }

  window.usermod.on<State>("machine:state", async (s) => {
    if (s.phase !== "paused") {
      if (s.phase === "running" && modal) {
        modal.close();
        modal = null;
      }
      if (s.phase !== "paused") shownFor = s.phase === "running" ? null : shownFor;
      return;
    }
    if (s.line === null) return;
    const change = s.job.toolChanges.find((c) => Math.abs(c.line - s.line!) <= settings.windowLines);
    if (!change) return;
    const key = `${s.job.fileName}:${change.line}`;
    if (shownFor === key) return;
    shownFor = key;
    const info = await toolInfo(change.tool);
    modal?.close();
    modal = ui.modal("Tool change", { width: 440 });
    modal.body.append(
      rt.el("div", { style: { fontSize: "15px", fontWeight: "600", marginBottom: "6px" }, text: `Fit ${info}` }),
      rt.el("div", { class: "usermod-sub", text: `${s.job.fileName ?? "Program"} is holding at line ${s.line} (tool change at line ${change.line}). Change the bit, check the length offset, then resume.` }),
      ui.buttonRow([ui.button(`Resume (${settings.resumeCommand})`, resume, { primary: true }), ui.button("Dismiss", () => {
        modal?.close();
        modal = null;
      })])
    );
  });
})();
