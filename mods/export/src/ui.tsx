/*
 * Export report (UI): "Last export report…" in the MODS menu reads data/reports/latest.json through the loader's
 * read-file bridge and shows the stats and the depth / rapid / envelope checks. After each export it toasts a
 * one-line summary, and opens the report when a check failed.
 */
(function exportReportUi(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { KV, Row, Button, Sub, Section, SettingsForm } = ui.react;
  rt.register({ name: "export", version: "0.1.0" });

  interface Issue {
    kind: string;
    message: string;
    count: number;
    firstLine: number;
    worst: number;
  }
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
    stockThickness: number | null;
    issues: Issue[];
  }
  let lastSeen = "";
  const LATEST = "data/reports/latest.json";
  const isReport = (v: unknown): v is Report => typeof v === "object" && v !== null && typeof (v as Report).exportedAt === "string" && Array.isArray((v as Report).tools);
  async function latest(): Promise<Report | null> {
    const present = await window.usermod.exists(LATEST);
    if (!present.ok || !present.data) return null;
    const r = await window.usermod.readFile(LATEST);
    if (!r.ok) return null;
    try {
      const parsed: unknown = JSON.parse(r.data);
      if (!isReport(parsed)) return null;
      return { ...parsed, issues: Array.isArray(parsed.issues) ? parsed.issues : [], stockThickness: typeof parsed.stockThickness === "number" ? parsed.stockThickness : null };
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
            ["App header", h.machineModel || h.materialType ? `${String(h.machineModel ?? "?")} · ${String(h.materialType ?? "?")} · ${String(h.stockSize ?? "?")}` : "none"],
            ["Stock thickness", rep.stockThickness === null ? "unknown (set it below or export with a stock header)" : `${rep.stockThickness} mm`],
            ["Checks", rep.issues.length ? <span className="usermod-err">{`${rep.issues.length} problem type(s)`}</span> : <span className="usermod-ok">clean</span>]
          ]}
        />
        {rep.issues.map((i) => (
          <Section key={i.kind} title={i.kind.replace("-", " ")}>
            <div className="usermod-err">{i.message}</div>
            <Sub>{`${i.count} move(s), first at line ${i.firstLine}, worst value ${i.worst.toFixed(2)}`}</Sub>
          </Section>
        ))}
        <SettingsForm
          modName="export"
          title="Export settings"
          fields={[
            { key: "stockThickness", label: "Stock thickness (mm, empty = from the program header)", type: "number", nullable: true, min: 0, step: 0.5 },
            { key: "allowanceBelow", label: "Allowed cut below the stock (mm, into the spoilboard)", type: "number", min: 0, step: 0.1 },
            { key: "safeZ", label: "Minimum Z for X/Y rapids (mm)", type: "number", step: 0.5 },
            { key: "checkRapids", label: "Check low rapids", type: "boolean" },
            { key: "xMin", label: "X min (mm, empty = off)", type: "number", nullable: true },
            { key: "xMax", label: "X max (mm, empty = off)", type: "number", nullable: true },
            { key: "yMin", label: "Y min (mm, empty = off)", type: "number", nullable: true },
            { key: "yMax", label: "Y max (mm, empty = off)", type: "number", nullable: true },
            { key: "keep", label: "Reports to keep", type: "number", min: 1, step: 10 },
            { key: "template", label: "Save dialog name template", type: "string", nullable: false, placeholder: "{name} {date}", help: "{name} {project} {date} {time} {datetime}" },
            { key: "saveDir", label: "Default save folder (empty = last used)", type: "string", nullable: false, placeholder: "D:\\CNC" },
            { key: "copyTo", label: "Also copy each export to (empty = off)", type: "string", nullable: false, placeholder: "E:\\CNC or \\\\server\\cnc" },
            { key: "copySubfolderByDate", label: "Put copies in YYYY-MM-DD subfolders", type: "boolean" },
            { key: "copyOverwrite", label: "Overwrite an existing copy", type: "boolean" }
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
    modal = ui.react.modal(rep.issues.length ? `Export report: ${rep.file} needs a look` : `Export report: ${rep.file}`, <ReportView rep={rep} close={() => modal?.close()} />, { width: 560 });
  }

  ui.toolbar.addButton({
    id: "export",
    title: "Exported file report",
    icon: () => ui.icons.svg("M6 2h8l4 4v16H6V2zm8 1.5V7h3.5L14 3.5zM8.5 12H10v6H8.5v-6zm3-3H13v9h-1.5V9zm3 5H16v4h-1.5v-4z"),
    order: 92,
    onClick: async () => {
      const rep = await latest();
      if (!rep) rt.toast("No export report yet (export a program first)", { kind: "warn" });
      else show(rep);
    }
  });
  // Light polling so a fresh export gets a summary toast (and the dialog when a check failed) without another IPC channel.
  setInterval(async () => {
    const rep = await latest();
    if (!rep || rep.exportedAt === lastSeen) return;
    const first = lastSeen === "";
    lastSeen = rep.exportedAt;
    if (first) return; // do not replay an old report at startup
    if (rep.issues.length) {
      rt.toast(`Exported ${rep.file}: ${rep.issues.length} check(s) failed`, { kind: "warn", duration: 6000 });
      show(rep);
    } else rt.toast(`Exported ${rep.file}: ${rep.lines} lines, tools ${rep.tools.map((t) => `T${t}`).join(" ") || "—"}, Z ${bounds(rep.bounds.Z)}`, { kind: "success", duration: 6000 });
  }, 3000);
})();
