/*
 * Status HUD: a small always-visible pill with machine state, progress and ETA (data from the
 * machine-state mod). Click it for details. Hidden while disconnected unless configured otherwise.
 *
 * mods.json settings ("status-hud"): position ("bottom-left" | "bottom-right" | "top-right"), showWhenDisconnected
 */
(function statusHud(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "status-hud", version: "0.1.0" });

  interface State {
    connected: boolean;
    status: string | null;
    alarm: string | null;
    phase: string;
    line: number | null;
    job: { fileName: string | null; lines: number | null; runTimeSeconds: number | null; startedAt: number | null };
    elapsedSeconds: number;
    progress: number | null;
    etaSeconds: number | null;
  }
  let settings = { position: "bottom-left", showWhenDisconnected: false };
  let last: State | null = null;

  rt.addStyle(
    `#usermod-hud{position:fixed;z-index:2147482500;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:rgba(24,24,24,.88);color:#fff;font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer;user-select:none;backdrop-filter:blur(4px)}
     #usermod-hud[data-pos="bottom-left"]{left:16px;bottom:16px}#usermod-hud[data-pos="bottom-right"]{right:16px;bottom:16px}#usermod-hud[data-pos="top-right"]{right:120px;top:52px}
     #usermod-hud .dot{width:8px;height:8px;border-radius:50%;background:#9e9e9e;flex:none}
     #usermod-hud[data-phase="running"] .dot{background:#22c55e;box-shadow:0 0 6px #22c55e}#usermod-hud[data-phase="paused"] .dot{background:#f59e0b}#usermod-hud[data-phase="alarm"] .dot{background:#ef4444}
     #usermod-hud .bar{width:90px;height:4px;border-radius:2px;background:rgba(255,255,255,.2);overflow:hidden}#usermod-hud .bar i{display:block;height:100%;background:#22c55e;width:0}
     #usermod-hud .muted{opacity:.7}`,
    "status-hud"
  );
  const dot = rt.el("span", { class: "dot" });
  const text = rt.el("span");
  const fill = rt.el("i");
  const bar = rt.el("span", { class: "bar" }, [fill]);
  const eta = rt.el("span", { class: "muted" });
  const hud = rt.el("div", { id: "usermod-hud", "data-pos": settings.position, "data-phase": "disconnected", title: "Machine status (click for details)", onClick: () => details() }, [dot, text, bar, eta]);
  hud.hidden = true;
  document.body.appendChild(hud);

  const fmt = (s: number | null): string => (s === null ? "" : rt.formatDuration(s));
  function render(s: State): void {
    last = s;
    hud.dataset.pos = settings.position;
    hud.dataset.phase = s.phase;
    const visible = s.connected || settings.showWhenDisconnected;
    hud.hidden = !visible;
    if (!visible) return;
    const name = s.job.fileName ?? "";
    const pct = s.progress !== null ? `${Math.round(s.progress * 100)}%` : "";
    text.textContent = s.phase === "alarm" ? `Alarm ${s.alarm ?? ""}` : s.phase === "disconnected" ? "Disconnected" : `${s.status ?? s.phase}${name ? ` · ${name}` : ""}${pct ? ` · ${pct}` : ""}`;
    bar.hidden = s.progress === null;
    fill.style.width = `${Math.round((s.progress ?? 0) * 100)}%`;
    eta.textContent = s.phase === "running" && s.etaSeconds ? `${fmt(s.etaSeconds)} left` : s.phase !== "idle" && s.elapsedSeconds ? fmt(s.elapsedSeconds) : "";
  }
  function details(): void {
    const s = last;
    const modal = ui.modal("Machine status", { width: 420 });
    modal.body.append(
      s
        ? ui.kv([
            ["Connection", s.connected ? "connected" : "disconnected"],
            ["Status", s.status ?? "—"],
            ["Phase", s.phase],
            ["Program", s.job.fileName ?? "—"],
            ["Line", s.line ? `${s.line}${s.job.lines ? ` / ${s.job.lines}` : ""}` : "—"],
            ["Elapsed", s.elapsedSeconds ? fmt(s.elapsedSeconds) : "—"],
            ["ETA", fmt(s.etaSeconds) || "—"],
            ["App estimate", s.job.runTimeSeconds ? fmt(s.job.runTimeSeconds) : "—"],
            ["Alarm", s.alarm ?? "—"]
          ])
        : rt.el("div", { text: "No machine data yet (is the machine-state mod enabled and the machine connected?)" }),
      ui.settingsForm("status-hud", {
        title: "Settings",
        reloadPostprocessors: false,
        fields: [
          { key: "position", label: "Position", type: "select", options: [{ label: "Bottom left", value: "bottom-left" }, { label: "Bottom right", value: "bottom-right" }, { label: "Top right", value: "top-right" }] },
          { key: "showWhenDisconnected", label: "Show while disconnected", type: "boolean" }
        ],
        onSaved: (v) => {
          settings = { position: String(v.position ?? settings.position), showWhenDisconnected: v.showWhenDisconnected === true };
          if (last) render(last);
        }
      })
    );
  }

  void window.usermod.info().then((r) => {
    if (r.ok) {
      const mine = r.data.config.settings["status-hud"] ?? {};
      settings = { position: String(mine.position ?? "bottom-left"), showWhenDisconnected: mine.showWhenDisconnected === true };
    }
    return window.usermod.invoke<State>("machine:state").then((s) => s.ok && render(s.data));
  });
  window.usermod.on<State>("machine:state", render);
  setInterval(() => void window.usermod.invoke<State>("machine:state").then((s) => s.ok && render(s.data)), 5000);
  ui.toolbar.addButton({ id: "status-hud", title: "Machine status details", icon: () => ui.icons.svg("M12 4a9 9 0 0 1 9 9 1 1 0 0 1-1 1H4a1 1 0 0 1-1-1 9 9 0 0 1 9-9zm5 4.6-4.3 4.3 1.4 1.4 4.3-4.3-1.4-1.4z"), order: 28, onClick: () => details() });
})();
