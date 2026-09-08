/*
 * React demo: the reference for writing UI mods in TSX. Opens a kit modal and mounts a React component into
 * its body with window.usermodReactRuntime.mount(). The component subscribes to machine:state (from the
 * machine-state mod) and shows a live table plus a counter, to demonstrate state, effects and cleanup.
 *
 * Build settings (see tsconfig.json): "jsx": "react" against the UMD globals React / ReactDOM, emitted as a plain script.
 */
(function reactDemo(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "react-demo", version: "0.1.0" });

  interface MachineState {
    connected: boolean;
    status: string | null;
    phase: string;
    line: number | null;
    job: { fileName: string | null; lines: number | null };
    elapsedSeconds: number;
    etaSeconds: number | null;
  }

  function MachinePanel(): React.JSX.Element {
    const { useEffect, useState } = React;
    const [state, setState] = useState<MachineState | null>(null);
    const [ticks, setTicks] = useState(0);

    useEffect(() => {
      let cancelled = false;
      void window.usermod.invoke<MachineState>("machine:state").then((r) => {
        if (!cancelled && r.ok) setState(r.data);
      });
      const unsubscribe = window.usermod.on<MachineState>("machine:state", (s) => setState(s));
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }, []);

    const rows: [string, string][] = state
      ? [
          ["Connection", state.connected ? "connected" : "disconnected"],
          ["Status", state.status ?? "—"],
          ["Phase", state.phase],
          ["Program", state.job.fileName ?? "—"],
          ["Line", state.line !== null ? `${state.line}${state.job.lines ? ` / ${state.job.lines}` : ""}` : "—"],
          ["Elapsed", state.elapsedSeconds ? rt.formatDuration(state.elapsedSeconds) : "—"],
          ["ETA", state.etaSeconds ? rt.formatDuration(state.etaSeconds) : "—"]
        ]
      : [];

    return (
      <div>
        <p className="usermod-sub">Rendered by React {React.version} (the mod runtime's own copy).</p>
        {state ? (
          <dl className="usermod-kv">
            {rows.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : (
          <p>No machine data yet. Enable the machine-state mod and connect a machine.</p>
        )}
        <div className="usermod-row">
          <button className="usermod-btn" onClick={() => setTicks((n) => n + 1)}>
            Clicked {ticks} time{ticks === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    );
  }

  rt.menu.addAction({
    id: "react-demo",
    label: "React demo…",
    section: "Developer",
    order: 90,
    onClick: ({ close }) => {
      close();
      if (!window.usermodReactRuntime) {
        rt.toast("React runtime not loaded (build packages/react-runtime)", { kind: "warn" });
        return;
      }
      const modal = ui.modal("React demo", { width: 440 });
      const unmount = window.usermodReactRuntime.mount(modal.body, <MachinePanel />);
      // Unmount when the modal goes away so effects (the machine:state subscription) are cleaned up.
      const observer = new MutationObserver(() => {
        if (!modal.root.isConnected) {
          unmount();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true });
    }
  });
})();
