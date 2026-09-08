/*
 * Tool-change assistant: when the machine enters Hold near a tool-change line of the running program
 * (M6 / M0 / tool-change-guard markers, as scanned by the machine-state mod), pops a dialog naming the
 * tool (with its library name and diameter when found) and offers Resume (sends the configured cycle-start
 * command, GRBL "~" by default).
 *
 * mods.json settings ("tool-change", shared with the post-processor half): resumeCommand ("~"), windowLines (3)
 */
(function toolChangeAssistant(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "tool-change", version: "0.2.0" });

  /** The touch-plate wizard, when the work-zero mod is on to provide it. */
  interface Probe {
    run(): Promise<void>;
    enabled(): boolean;
  }
  const probe = (): Probe | null => ui.consume<Probe>("probe");

  interface State {
    phase: string;
    line: number | null;
    job: { fileName: string | null; toolChanges: { line: number; tool: string | null }[] };
  }
  let settings: { resumeCommand: string; windowLines: number } = { resumeCommand: "~", windowLines: 3 };
  let shownFor: string | null = null;
  let modal: Usermod.ModalHandle | null = null;

  void window.usermod.info().then((r) => {
    if (!r.ok) return;
    const mine = r.data.config.settings["tool-change"] ?? {};
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
    const r = await window.api.device.sendMessage({ type: "text", payload: settings.resumeCommand });
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
      ui.buttonRow([
        ui.button(`Resume (${settings.resumeCommand})`, resume, { primary: true }),
        // Offered when the work-zero mod is on to provide it: re-zero Z for the new bit, then resume.
        probe()?.enabled() === true
          ? ui.button("Probe Z, then resume", async () => {
            const wizard = probe();
            if (!wizard) return;
            await wizard.run();
            const state = await window.usermod.invoke<Usermod.MachineState>("machine:state");
            if (state.ok && state.data.phase === "paused") await resume();
          }, { title: "Runs the touch-plate wizard; resumes only when probing finished with the program still held" })
          : null,
        ui.button("Dismiss", () => {
          modal?.close();
          modal = null;
        })
      ])
    );
  });

  /* Its own toolbar icon: the dialog only appears when the machine holds, so this shows the state and settings. */
  ui.toolbar.addButton({
    id: "tool-change",
    title: "Tool change assistant",
    icon: () => ui.icons.svg("M14.5 2a5.5 5.5 0 0 1 5.2 7.3l-2.1-2.1-2.8 2.8 2.1 2.1A5.5 5.5 0 0 1 9.7 8.3L4.4 3 3 4.4l5.3 5.3a5.5 5.5 0 0 0 6.2 8.8l-2.1-2.1 2.8-2.8 2.1 2.1A5.5 5.5 0 0 1 14.5 2zM6 17.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"),
    order: 45,
    onClick: async (button) => {
      const state = await window.usermod.invoke<Usermod.MachineState>("machine:state");
      const s = state.ok ? state.data : null;
      const pop = ui.popover(button, { width: 380 });
      pop.body.append(
        rt.el("h3", { text: "Tool change assistant" }),
        rt.el("div", { class: "usermod-sub", text: "When the machine holds within a few lines of a tool change, a dialog names the tool from your library and offers Resume (and Probe Z when the z-probe mod is on)." }),
        ui.kv([
          ["Machine", s ? `${s.status ?? "—"}${s.line !== null ? ` · line ${s.line}` : ""}` : "machine-state mod off"],
          ["Program", s?.job.fileName ?? "—"],
          ["Tool changes found", s ? String(s.job.toolChanges.length) : "—"],
          ["Next", s?.job.toolChanges.find((c) => s.line !== null && c.line >= s.line)?.tool ?? "—"]
        ]),
        ui.settingsForm("tool-change", {
          title: "Settings",
          reloadPostprocessors: false,
          fields: [
            { key: "resumeCommand", label: "Resume command", type: "string", nullable: false, help: "GRBL cycle start is ~" },
            { key: "windowLines", label: "Lines around a tool change that count as holding there", type: "number", min: 0, max: 20, step: 1 }
          ],
          onSaved: (values) => {
            settings = { resumeCommand: typeof values.resumeCommand === "string" && values.resumeCommand ? values.resumeCommand : "~", windowLines: Number(values.windowLines ?? 3) || 3 };
          }
        })
      );
    }
  });
})();
