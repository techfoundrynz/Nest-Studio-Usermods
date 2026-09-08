/*
 * Export report (UI): "Last export report…" in the MODS menu reads data/reports/latest.json through the
 * loader's read-file bridge and shows it (React, via the kit). Toasts a one-line summary after each export.
 */
(function exportReportUi(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { KV, Row, Button } = ui.react;
  rt.register({ name: "export-report", version: "0.2.0" });

  interface Report {
    file: string;
    path: string;
    exportedAt: string;
    lines: number;
    bytes: number;
    tools: number[];
    feed: [number, number] | null;
    spindleMax: number | null;
    bounds: Record<"X" | "Y" | "Z", [number, number] | null>;
    relativeMoves: boolean;
    programEnd: boolean;
    header: Record<string, unknown> | null;
    toolChanges: number;
  }
  let lastSeen = "";

  const LATEST = "data/reports/latest.json";
  async function latest(): Promise<Report | null> {
    const present = await window.usermod.exists(LATEST);
    if (!present.ok || !present.data) return null;
    const r = await window.usermod.readFile(LATEST);
    if (!r.ok) return null;
    try {
      return JSON.parse(r.data) as Report;
    } catch {
      return null;
    }
  }
  const bounds = (b: [number, number] | null): string => (b ? `${b[0].toFixed(2)} … ${b[1].toFixed(2)}` : "—");

  function ReportView({ rep, close }: { rep: Report; close(): void }): React.JSX.Element {
    const h = rep.header ?? {};
    return (
      <>
        <KV
          pairs={[
            ["Exported", new Date(rep.exportedAt).toLocaleString()],
            ["Path", rep.path || "—"],
            ["Size", `${rep.lines} lines, ${rt.formatBytes(rep.bytes)}`],
            ["Tools", rep.tools.length ? rep.tools.map((t) => `T${t}`).join(", ") : "—"],
            ["Tool changes", String(rep.toolChanges)],
            ["Feed", rep.feed ? `${rep.feed[0]} – ${rep.feed[1]}` : "—"],
            ["Spindle max", rep.spindleMax === null ? "—" : String(rep.spindleMax)],
            ["X", bounds(rep.bounds.X)],
            ["Y", bounds(rep.bounds.Y)],
            ["Z", bounds(rep.bounds.Z)],
            ["Program end", rep.programEnd ? "yes" : "missing"],
            ["Relative moves", rep.relativeMoves ? "yes (bounds partial)" : "no"],
            ["App header", h.machineModel || h.materialType ? `${String(h.machineModel ?? "?")} · ${String(h.materialType ?? "?")} · ${String(h.stockSize ?? "?")}` : "none"]
          ]}
        />
        <Row>
          <Button label="Open reports folder" onClick={() => void window.usermod.openModDir()} />
          <Button label="Close" primary onClick={close} />
        </Row>
      </>
    );
  }
  function show(rep: Report): void {
    let modal: Usermod.ModalHandle | null = null;
    modal = ui.react.modal(`Export report: ${rep.file}`, <ReportView rep={rep} close={() => modal?.close()} />, { width: 520 });
  }

  rt.menu.addAction({
    id: "export-report",
    label: "Last export report…",
    section: "Tools",
    order: 20,
    onClick: async ({ close }) => {
      close();
      const rep = await latest();
      if (!rep) rt.toast("No export report yet (export a program first)", { kind: "warn" });
      else show(rep);
    }
  });
  // Light polling so a fresh export gets a summary toast without wiring another IPC channel.
  setInterval(async () => {
    const rep = await latest();
    if (rep && rep.exportedAt !== lastSeen) {
      if (lastSeen) rt.toast(`Exported ${rep.file}: ${rep.lines} lines, tools ${rep.tools.map((t) => `T${t}`).join(" ") || "—"}, Z ${bounds(rep.bounds.Z)}`, { kind: "success", duration: 6000 });
      lastSeen = rep.exportedAt;
    }
  }, 4000);
})();
