/** Native inspection owns error analysis; this mod only exports a three-axis height-field STL. */
(function stockExport(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Button, KV, Err } = ui.react;
  rt.register({ name: "stock-export", version: "0.2.0" });
  function Panel(): React.JSX.Element {
    const [grid, setGrid] = React.useState<UsermodStockGrid | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const abort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => abort.current?.abort(), []);
    const compute = async (): Promise<void> => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true); setError(null); setGrid(null);
      try {
        const runtimes = [...globalThis.__usermodSimRuntimes ?? []];
        const runtime = runtimes.reverse().find(r => !r.manager.disposed && r.stockRemoval?.isActive() && r.manager.renderer.domElement.isConnected);
        if (!runtime || !globalThis.__usermodStockExport) throw new Error("Open Preview, turn on material removal, and wait for its timeline to load.");
        const result = await globalThis.__usermodStockExport(runtime, controller.signal);
        controller.signal.throwIfAborted();
        setGrid(result);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { setBusy(false); }
    };
    const exportStl = async (): Promise<void> => {
      if (!grid) return;
      const dialog = await window.api.dialog.showSave({ defaultPath: "machined-stock.stl", filters: [{ name: "STL", extensions: ["stl"] }] });
      if (!dialog.ok || dialog.data.canceled || !dialog.data.filePath) return;
      const info = await window.usermod.info();
      const stride = info.ok ? Number(info.data.config.settings["stock-export"]?.exportStride) || 1 : 1;
      const result = await window.usermod.invoke<{ triangles: number }>("stock:export-stl", { ...grid, filePath: dialog.data.filePath, stride });
      if (!result.ok) throw new Error(result.message);
      rt.toast(`Exported ${result.data.triangles} triangles`, { kind: "success" });
    };
    const retained = grid ? grid.heights.reduce((sum, z, i) => sum + Math.max(0, z - grid.minZ) * (i % grid.nx === 0 || i % grid.nx === grid.nx - 1 ? 0.5 : 1) * (i < grid.nx || i >= grid.nx * (grid.ny - 1) ? 0.5 : 1), 0) * grid.dx * grid.dy : 0;
    return <>
      <Sub>Export the current face as an approximate three-axis height field. Four-axis cuts and undercuts are excluded. Use the native Preview report for machining inspection.</Sub>
      <Button label={busy ? "Computing stock…" : "Compute machined stock"} primary disabled={busy} onClick={compute} />
      {busy ? <Button label="Cancel" onClick={() => abort.current?.abort()} /> : null}
      {error ? <Err>{error}</Err> : null}
      {grid ? <><KV pairs={[["Grid", `${grid.nx} × ${grid.ny}`], ["Approximate retained volume", `${(retained / 1000).toFixed(2)} cm³`]]} /><Button label="Export machined stock (STL)…" onClick={exportStl} /></> : null}
    </>;
  }
  ui.toolbar.addButton({ id: "stock-export", title: "Machined stock STL export", order: 49,
    icon: () => ui.icons.svg("M3 6l9-4 9 4v12l-9 4-9-4V6zm9 4v12M3 6l9 4 9-4"),
    onClick: button => { ui.react.popover(button, <Panel />, { width: 430 }); }
  });
})();
