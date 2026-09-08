/*
 * LAN monitor (UI): "LAN monitor…" in the MODS menu shows the addresses to open on a phone, whether the
 * server is up, and the settings form.
 */
(function lanMonitorUi(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { KV, Sub, Row, Button, SettingsForm, Loading, Err, useInvoke } = ui.react;
  rt.register({ name: "lan-monitor", version: "0.1.0" });

  interface Status {
    listening: boolean;
    port: number;
    host: string;
    token: boolean;
    urls: string[];
    requests: number;
    cameraAt: number | null;
    error: string | null;
  }
  function Panel(): React.JSX.Element {
    const { data: st, error, refresh } = useInvoke<Status>("monitor:status");
    React.useEffect(() => {
      const t = setInterval(() => void refresh(), 3000);
      return () => clearInterval(t);
    }, [refresh]);
    if (error) return <Err>{error}</Err>;
    if (!st) return <Loading />;
    return (
      <>
        <KV
          pairs={[
            ["Server", st.listening ? <span className="usermod-ok">listening</span> : <span className="usermod-err">{st.error ?? "not listening"}</span>],
            ["Access", st.token ? "token required (?t=…)" : "anyone on the network"],
            ["Requests", String(st.requests)],
            ["Camera frame", st.cameraAt ? new Date(st.cameraAt).toLocaleTimeString() : "none yet (connect the machine)"]
          ]}
        />
        <Sub>Open one of these on a phone or another PC on the same network:</Sub>
        {st.urls.map((u) => {
          const url = u.split("  ")[0] ?? u;
          return (
            <Row key={u}>
              <code style={{ fontSize: 12 }}>{u}</code>
              <Button
                label="Copy"
                onClick={async () => {
                  await navigator.clipboard.writeText(url);
                  rt.toast("Address copied", { kind: "success" });
                }}
              />
            </Row>
          );
        })}
        <SettingsForm
          modName="lan-monitor"
          title="Settings (restart Nest Studio to apply)"
          reloadPostprocessors={false}
          fields={[
            { key: "port", label: "Port", type: "number", min: 1024, max: 65535, step: 1 },
            { key: "host", label: "Listen on", type: "select", options: [{ value: "0.0.0.0", label: "All interfaces (LAN)" }, { value: "127.0.0.1", label: "This PC only" }] },
            { key: "token", label: "Access token (empty = open)", type: "string", nullable: false, placeholder: "e.g. shop-42" },
            { key: "camera", label: "Camera", type: "select", options: [{ value: "overall", label: "Overall view" }, { value: "topview", label: "Top view" }] }
          ]}
        />
      </>
    );
  }
  ui.toolbar.addButton({
    id: "lan-monitor",
    title: "LAN monitor: status page for phones on the network",
    icon: () => ui.icons.svg("M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6H4z"),
    order: 62,
    onClick: () => {
      ui.react.modal("LAN monitor", <Panel />, { width: 520 });
    }
  });
})();
