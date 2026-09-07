/*
 * Device macros: user-defined buttons that send G-code / controller commands through the app's own device
 * channel (window.api.device.sendMessage), one line at a time. Edit macros in mods.json:
 *
 *   "device-macros": { "confirmAll": false, "macros": [
 *     { "name": "Safe Z", "lines": ["G53 G90 G0 Z-1"], "confirm": true }, ... ] }
 *
 * Macros move the machine. Every macro with "confirm": true (or confirmAll) asks first.
 */
(function deviceMacros(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "device-macros", version: "0.1.0" });

  interface Macro {
    name: string;
    lines: string[];
    confirm?: boolean;
  }
  let macros: Macro[] = [];
  let confirmAll = false;

  async function load(): Promise<void> {
    const r = await window.usermod.info();
    if (!r.ok) return;
    const mine = r.data.config.settings["device-macros"] ?? {};
    confirmAll = mine.confirmAll === true;
    macros = Array.isArray(mine.macros)
      ? (mine.macros as unknown[]).flatMap((m) => {
          if (typeof m !== "object" || m === null) return [];
          const o = m as Record<string, unknown>;
          const lines = Array.isArray(o.lines) ? o.lines.filter((l): l is string => typeof l === "string" && l.trim() !== "") : [];
          return typeof o.name === "string" && lines.length ? [{ name: o.name, lines, confirm: o.confirm === true }] : [];
        })
      : [];
  }

  async function connected(): Promise<boolean> {
    try {
      const r = (await (window.api.device.getStatus as () => Promise<NestStudio.Result<{ connected?: boolean }>>)()) as NestStudio.Result<{ connected?: boolean }>;
      return r.ok && r.data?.connected === true;
    } catch {
      return false;
    }
  }
  async function run(macro: Macro): Promise<void> {
    if (!(await connected())) {
      rt.toast("No machine connected", { kind: "warn" });
      return;
    }
    const send = window.api.device.sendMessage as (m: { type: "text"; payload: string }) => Promise<NestStudio.Result<unknown>>;
    for (const line of macro.lines) {
      const r = await send({ type: "text", payload: line });
      if (!r.ok) throw new Error(`${line}: ${r.message ?? r.code ?? "send failed"}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    rt.toast(`Macro "${macro.name}" sent (${macro.lines.length} line${macro.lines.length === 1 ? "" : "s"})`, { kind: "success" });
    rt.log("info", `macro ${macro.name}: ${macro.lines.join(" | ")}`);
  }
  function confirmThenRun(macro: Macro): void {
    if (!(macro.confirm || confirmAll)) {
      void run(macro);
      return;
    }
    const modal = ui.modal(`Run macro "${macro.name}"?`, { width: 420 });
    modal.body.append(
      rt.el("div", { class: "usermod-mono", text: macro.lines.join("\n") }),
      rt.el("small", { class: "usermod-sub", text: "This is sent to the connected machine exactly as shown." }),
      ui.buttonRow([
        ui.button("Send", async () => {
          modal.close();
          await run(macro);
        }, { primary: true }),
        ui.button("Cancel", () => modal.close())
      ])
    );
  }

  const handle = ui.toolbar.addButton({
    id: "device-macros",
    title: "Machine macros",
    icon: () => ui.icons.svg("M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"),
    order: 40,
    onClick: async (button) => {
      await load();
      const pop = ui.popover(button, { width: 320 });
      pop.body.append(
        rt.el("h3", { text: "Macros" }),
        macros.length
          ? rt.el("div", { class: "usermod-row" }, macros.map((m) => ui.button(m.name, () => confirmThenRun(m), { title: m.lines.join(" | ") })))
          : rt.el("div", { class: "usermod-sub", text: "No macros. Add them under settings.device-macros.macros in mods.json." }),
        ui.buttonRow([
          ui.button("Edit macros (mods.json)", () => void window.usermod.openModDir()),
          ui.button("Reload", async () => {
            await window.usermod.reload();
            pop.close();
            rt.toast("Macros reloaded");
          })
        ])
      );
    }
  });
  void handle;
})();
