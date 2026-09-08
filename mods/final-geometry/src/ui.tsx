/*
 * Final geometry (UI): what will the part look like after machining, and how does it differ from the model?
 *
 * The Preview tab's material simulation keeps the machined stock as a Z height field (one column per 0.1 mm or
 * so, stock-centred, top of stock at Z = 0). This mod:
 *   1. jumps the simulation to its last sample (the app's own "settle" seek),
 *   2. reads the height field, rasterises the imported model(s) into the same grid (upper envelope),
 *   3. builds its own coloured mesh of the machined surface: green = within tolerance of the model,
 *      yellow→red = material left standing (rest), blue = cut into the model (overcut), grey = stock outside
 *      the model footprint,
 *   4. reports volumes and extremes, can show the model as a ghost over the result, and exports the machined
 *      stock as a binary STL (through the main-process half).
 * Needs the Preview tab with material simulation turned on (that is what creates the simulation timeline) and
 * the installer's simulation-runtime patch. Vertical comparison only: exact for what a 3-axis top-down cut can
 * reproduce, blind to undercuts. One side at a time: on a flip face the app presents the model flipped, so
 * the comparison is against that face.
 *
 * mods.json settings ("final-geometry"): toleranceMm (0.1), hideOutside (false), exportStride (1)
 */
(function finalGeometry(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Sub, Row, Button, KV, Toggle, Input, Err } = ui.react;
  rt.register({ name: "final-geometry", version: "0.1.0" });

  const GROUP_NAME = "usermodFinalGeometry";
  const MODELS_GROUP = "editor3dModels";
  interface Settings {
    toleranceMm: number;
    hideOutside: boolean;
    exportStride: number;
  }
  let settings: Settings = { toleranceMm: 0.1, hideOutside: false, exportStride: 1 };
  void window.usermod.info().then((r) => {
    if (!r.ok) return;
    const m = r.data.config.settings["final-geometry"] ?? {};
    settings = { toleranceMm: Number(m.toleranceMm) > 0 ? Number(m.toleranceMm) : 0.1, hideOutside: m.hideOutside === true, exportStride: Number(m.exportStride) >= 1 ? Math.floor(Number(m.exportStride)) : 1 };
  });

  /* ------------------------------------------------------------ runtime */
  function runtime(): UsermodSimRuntimeLike | null {
    let best: UsermodSimRuntimeLike | null = null;
    for (const r of globalThis.__usermodSimRuntimes ?? []) {
      if (r.manager.disposed) continue;
      if (r.stockRemoval?.timeline) return r;
      best ??= r;
    }
    return best;
  }
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  async function runToEnd(r: UsermodSimRuntimeLike, log: (s: string) => void): Promise<void> {
    const sr = r.stockRemoval;
    if (!sr) throw new Error("This scene has no material simulation.");
    if (!sr.timeline || !sr.spec) throw new Error("Turn on the material simulation view in the Preview tab first, then compute.");
    const total = sr.timelineSampleCount();
    if (total <= 0) throw new Error("The simulation timeline is empty.");
    log(`Simulating ${total} samples…`);
    r.seekStockRemoval(Number.MAX_SAFE_INTEGER, { sync: true, refineNormals: true });
    const started = Date.now();
    while (sr.getSampleIndex() < total - 1) {
      if (Date.now() - started > 180000) throw new Error("Timed out waiting for the simulation worker.");
      await sleep(120);
    }
    await sleep(150); // let the last mesh flush land
    log(`Simulation complete (${((Date.now() - started) / 1000).toFixed(1)} s).`);
  }

  /* ------------------------------------------------------------- compare */
  interface Grid {
    nx: number;
    ny: number;
    minX: number;
    minY: number;
    dx: number;
    dy: number;
    minZ: number;
    heights: Float32Array;
  }
  interface Stats {
    columns: number;
    footprint: number;
    withinTol: number;
    restVolume: number;
    gougeVolume: number;
    outsideVolume: number;
    maxRest: number;
    maxGouge: number;
    modelTriangles: number;
    resolution: number;
  }
  interface Compare {
    grid: Grid;
    modelTop: Float32Array;
    deviation: Float32Array;
    stats: Stats;
  }
  function readGrid(sr: UsermodStockRemovalLike): Grid {
    if (!sr.spec || !sr.volume) throw new Error("No simulated stock yet.");
    const { nx, ny, bounds } = sr.spec;
    const heights = new Float32Array(nx * ny);
    sr.volume.fillTopHeights(heights);
    return { nx, ny, minX: bounds.minX, minY: bounds.minY, dx: (bounds.maxX - bounds.minX) / (nx - 1), dy: (bounds.maxY - bounds.minY) / (ny - 1), minZ: bounds.minZ, heights };
  }
  /** Upper envelope of every model mesh on the dexel grid (−Infinity where no model covers the column). */
  function rasterizeModels(scene: UsermodObject3DLike, grid: Grid): { top: Float32Array; triangles: number } {
    const top = new Float32Array(grid.nx * grid.ny).fill(-Infinity);
    const models = scene.getObjectByName(MODELS_GROUP);
    let triangles = 0;
    if (!models) return { top, triangles };
    const v = new Float64Array(9);
    for (const mesh of models.children) {
      const pos = mesh.geometry?.getAttribute("position");
      if (!pos) continue;
      mesh.updateMatrixWorld(true);
      const m = mesh.matrixWorld.elements;
      const idx = mesh.geometry?.index?.array ?? null;
      const count = idx ? idx.length : Math.floor(pos.array.length / 3);
      const arr = pos.array;
      for (let t = 0; t + 2 < count; t += 3) {
        for (let k = 0; k < 3; k += 1) {
          const vi = (idx ? idx[t + k] ?? 0 : t + k) * 3;
          const x = arr[vi] ?? 0;
          const y = arr[vi + 1] ?? 0;
          const z = arr[vi + 2] ?? 0;
          v[k * 3] = (m[0] ?? 1) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
          v[k * 3 + 1] = (m[1] ?? 0) * x + (m[5] ?? 1) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
          v[k * 3 + 2] = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 1) * z + (m[14] ?? 0);
        }
        triangles += 1;
        const ax = v[0]!;
        const ay = v[1]!;
        const az = v[2]!;
        const bx = v[3]!;
        const by = v[4]!;
        const bz = v[5]!;
        const cx = v[6]!;
        const cy = v[7]!;
        const cz = v[8]!;
        const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.abs(area) < 1e-12) continue;
        const ix0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - grid.minX) / grid.dx));
        const ix1 = Math.min(grid.nx - 1, Math.floor((Math.max(ax, bx, cx) - grid.minX) / grid.dx));
        const iy0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - grid.minY) / grid.dy));
        const iy1 = Math.min(grid.ny - 1, Math.floor((Math.max(ay, by, cy) - grid.minY) / grid.dy));
        const inv = 1 / area;
        for (let iy = iy0; iy <= iy1; iy += 1) {
          const py = grid.minY + iy * grid.dy;
          for (let ix = ix0; ix <= ix1; ix += 1) {
            const px = grid.minX + ix * grid.dx;
            // Barycentric weights; a small negative tolerance keeps shared edges covered.
            const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * inv;
            const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * inv;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const z = w0 * az + w1 * bz + w2 * cz;
            const i = iy * grid.nx + ix;
            if (z > (top[i] ?? -Infinity)) top[i] = z;
          }
        }
      }
    }
    return { top, triangles };
  }
  function compare(sr: UsermodStockRemovalLike, scene: UsermodObject3DLike, tol: number): Compare {
    const grid = readGrid(sr);
    const { top, triangles } = rasterizeModels(scene, grid);
    const deviation = new Float32Array(grid.nx * grid.ny);
    const cell = grid.dx * grid.dy;
    const stats: Stats = { columns: grid.nx * grid.ny, footprint: 0, withinTol: 0, restVolume: 0, gougeVolume: 0, outsideVolume: 0, maxRest: 0, maxGouge: 0, modelTriangles: triangles, resolution: sr.spec?.resolutionMm ?? 0 };
    for (let i = 0; i < deviation.length; i += 1) {
      const h = grid.heights[i] ?? grid.minZ;
      const mt = top[i] ?? -Infinity;
      if (!Number.isFinite(mt)) {
        deviation[i] = NaN;
        if (h > grid.minZ + 1e-4) stats.outsideVolume += (h - grid.minZ) * cell;
        continue;
      }
      const d = h - Math.max(mt, grid.minZ);
      deviation[i] = d;
      stats.footprint += 1;
      if (Math.abs(d) <= tol) stats.withinTol += 1;
      else if (d > 0) {
        stats.restVolume += d * cell;
        if (d > stats.maxRest) stats.maxRest = d;
      } else {
        stats.gougeVolume += -d * cell;
        if (-d > stats.maxGouge) stats.maxGouge = -d;
      }
    }
    return { grid, modelTop: top, deviation, stats };
  }

  /* ---------------------------------------------------------------- mesh */
  const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  type RGB = [number, number, number];
  const lin = (r: number, g: number, b: number): RGB => [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const C_OK = lin(0.35, 0.75, 0.42);
  const C_REST0 = lin(0.98, 0.85, 0.2);
  const C_REST1 = lin(0.85, 0.12, 0.08);
  const C_GOUGE0 = lin(0.35, 0.55, 0.98);
  const C_GOUGE1 = lin(0.08, 0.12, 0.55);
  const C_OUT = lin(0.72, 0.72, 0.7);
  const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  interface Built {
    group: UsermodObject3DLike;
    result: UsermodObject3DLike;
    ghosts: UsermodObject3DLike[];
    manager: UsermodSceneManagerLike;
    hidden: { stock: UsermodObject3DLike | null; models: UsermodObject3DLike | null };
  }
  let built: Built | null = null;

  function findMaterialCtor(scene: UsermodObject3DLike): UsermodMaterialCtor {
    const blank = scene.getObjectByName("blankMesh")?.material?.constructor;
    if (blank) return blank;
    let found: UsermodMaterialCtor | null = null;
    scene.traverse((o) => {
      if (!found && o.material && o.geometry) found = o.material.constructor;
    });
    if (!found) throw new Error("No mesh in the scene to borrow a material class from.");
    return found;
  }
  function buildMesh(r: UsermodSimRuntimeLike, cmp: Compare, tol: number, hideOutside: boolean): Built {
    const scene = r.manager.scene;
    const sr = r.stockRemoval;
    if (!sr) throw new Error("no stock removal");
    disposeBuilt();
    const g = cmp.grid;
    const GeometryCtor = scene.getObjectByName("blankMesh")?.geometry?.constructor ?? sr.group.children[0]?.geometry?.constructor;
    const anyGeometry = scene.getObjectByName("blankMesh")?.geometry ?? sr.group.children[0]?.geometry;
    const AttributeCtor = anyGeometry?.getAttribute("position")?.constructor;
    if (!GeometryCtor || !AttributeCtor) throw new Error("Could not reach the geometry classes (is the stock visible?).");
    const MaterialCtor = findMaterialCtor(scene);
    const ObjectCtor = sr.group.constructor;

    const n = g.nx * g.ny;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const maxRest = Math.max(tol * 4, Math.min(cmp.stats.maxRest, 3));
    const maxGouge = Math.max(tol * 4, Math.min(cmp.stats.maxGouge, 3));
    const lx = 0.35;
    const ly = 0.45;
    const lz = 0.82;
    for (let iy = 0; iy < g.ny; iy += 1) {
      for (let ix = 0; ix < g.nx; ix += 1) {
        const i = iy * g.nx + ix;
        const h = g.heights[i] ?? g.minZ;
        positions[i * 3] = g.minX + ix * g.dx;
        positions[i * 3 + 1] = g.minY + iy * g.dy;
        positions[i * 3 + 2] = h;
        const d = cmp.deviation[i] ?? NaN;
        let c: RGB;
        if (Number.isNaN(d)) c = C_OUT;
        else if (Math.abs(d) <= tol) c = C_OK;
        else if (d > 0) c = mix(C_REST0, C_REST1, Math.min(1, (d - tol) / maxRest));
        else c = mix(C_GOUGE0, C_GOUGE1, Math.min(1, (-d - tol) / maxGouge));
        // Bake simple lighting from the local slope so the surface reads as 3D under the flat material.
        const hx = (g.heights[iy * g.nx + Math.min(g.nx - 1, ix + 1)] ?? h) - (g.heights[iy * g.nx + Math.max(0, ix - 1)] ?? h);
        const hy = (g.heights[Math.min(g.ny - 1, iy + 1) * g.nx + ix] ?? h) - (g.heights[Math.max(0, iy - 1) * g.nx + ix] ?? h);
        let nx = -hx / (2 * g.dx);
        let ny = -hy / (2 * g.dy);
        let nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        nz /= len;
        const shade = 0.55 + 0.45 * Math.max(0, nx * lx + ny * ly + nz * lz);
        colors[i * 3] = c[0] * shade;
        colors[i * 3 + 1] = c[1] * shade;
        colors[i * 3 + 2] = c[2] * shade;
      }
    }
    const index: number[] = [];
    const eps = 1e-4;
    for (let iy = 0; iy < g.ny - 1; iy += 1) {
      for (let ix = 0; ix < g.nx - 1; ix += 1) {
        const a = iy * g.nx + ix;
        const b = a + 1;
        const c = a + g.nx;
        const d = c + 1;
        if ((g.heights[a] ?? g.minZ) <= g.minZ + eps || (g.heights[b] ?? g.minZ) <= g.minZ + eps || (g.heights[c] ?? g.minZ) <= g.minZ + eps || (g.heights[d] ?? g.minZ) <= g.minZ + eps) continue;
        if (hideOutside && Number.isNaN(cmp.deviation[a] ?? NaN) && Number.isNaN(cmp.deviation[b] ?? NaN) && Number.isNaN(cmp.deviation[c] ?? NaN) && Number.isNaN(cmp.deviation[d] ?? NaN)) continue;
        index.push(a, b, d, a, d, c);
      }
    }
    const geometry = new GeometryCtor();
    geometry.setAttribute("position", new AttributeCtor(positions, 3));
    geometry.setAttribute("color", new AttributeCtor(colors, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    const material = new MaterialCtor({ vertexColors: true, side: 2, polygonOffset: true, polygonOffsetFactor: -1 });
    const result = new ObjectCtor(geometry, material);
    result.name = "usermodFinalGeometryMesh";
    result.renderOrder = 5;
    const group = new ObjectCtor();
    group.name = GROUP_NAME;
    group.add(result);
    // Ghost copies of the model meshes share their geometry; only the material is ours.
    const ghosts: UsermodObject3DLike[] = [];
    const models = scene.getObjectByName(MODELS_GROUP);
    if (models) {
      const ghostMaterial = new MaterialCtor({ color: 0x4a7dff, transparent: true, opacity: 0.28, depthWrite: false, side: 2 });
      for (const mesh of models.children) {
        if (!mesh.geometry) continue;
        mesh.updateMatrixWorld(true);
        const ghost = new ObjectCtor(mesh.geometry, ghostMaterial);
        ghost.matrixAutoUpdate = false;
        ghost.matrix.copy(mesh.matrixWorld);
        ghost.name = "usermodFinalGeometryGhost";
        ghost.visible = false;
        group.add(ghost);
        ghosts.push(ghost);
      }
    }
    scene.add(group);
    r.manager.requestRender();
    built = { group, result, ghosts, manager: r.manager, hidden: { stock: null, models: null } };
    return built;
  }
  function disposeBuilt(): void {
    if (!built) return;
    if (built.hidden.stock) built.hidden.stock.visible = true;
    if (built.hidden.models) built.hidden.models.visible = true;
    built.group.parent?.remove(built.group);
    built.result.geometry?.dispose();
    built.result.material?.dispose();
    built.ghosts[0]?.material?.dispose();
    built.manager.requestRender();
    built = null;
  }
  rt.onRoute(() => disposeBuilt());

  /* ------------------------------------------------------------------ UI */
  const fmtVol = (mm3: number): string => (mm3 >= 1000 ? `${(mm3 / 1000).toFixed(2)} cm³` : `${mm3.toFixed(0)} mm³`);
  function Panel(): React.JSX.Element {
    const [, force] = React.useState(0);
    const rerender = (): void => force((n) => n + 1);
    const [log, setLog] = React.useState<string[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [cmp, setCmp] = React.useState<Compare | null>(null);
    const [tol, setTol] = React.useState(String(settings.toleranceMm));
    const [hideOutside, setHideOutside] = React.useState(settings.hideOutside);
    const [showGhost, setShowGhost] = React.useState(false);
    const [hideStock, setHideStock] = React.useState(true);
    const [hideModels, setHideModels] = React.useState(true);
    const r = runtime();
    const sr = r?.stockRemoval ?? null;
    const ready = Boolean(sr?.timeline && sr.spec);

    const applyVisibility = (b: Built | null, ghost: boolean, stock: boolean, models: boolean): void => {
      if (!b) return;
      const scene = b.manager.scene;
      const stockGroup = r?.stockRemoval?.group ?? null;
      const modelsGroup = scene.getObjectByName(MODELS_GROUP) ?? null;
      if (stockGroup) stockGroup.visible = !stock;
      if (modelsGroup) modelsGroup.visible = !models;
      b.hidden = { stock: stock ? stockGroup : null, models: models ? modelsGroup : null };
      for (const g of b.ghosts) g.visible = ghost;
      b.manager.requestRender();
    };
    const compute = async (): Promise<void> => {
      if (!r) return;
      setBusy(true);
      setError(null);
      setLog([]);
      const say = (s: string): void => setLog((prev) => [...prev, s]);
      try {
        await runToEnd(r, say);
        const t = Number(tol) > 0 ? Number(tol) : 0.1;
        const t0 = performance.now();
        const result = compare(r.stockRemoval!, r.manager.scene, t);
        say(`Compared ${result.stats.footprint} columns under ${result.stats.modelTriangles} model triangles in ${(performance.now() - t0).toFixed(0)} ms.`);
        const b = buildMesh(r, result, t, hideOutside);
        applyVisibility(b, showGhost, hideStock, hideModels);
        setCmp(result);
        void window.usermod.setSettings("final-geometry", { toleranceMm: t, hideOutside, exportStride: settings.exportStride });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
    const exportStl = async (): Promise<void> => {
      if (!cmp) return;
      const dialog = await window.api.dialog.showSave({ defaultPath: "machined-stock.stl", filters: [{ name: "STL", extensions: ["stl"] }] });
      if (!dialog.ok || !dialog.data.filePath || dialog.data.canceled) return;
      const g = cmp.grid;
      const res = await window.usermod.invoke<{ path: string; triangles: number; bytes: number }>("final:export-stl", { filePath: dialog.data.filePath, nx: g.nx, ny: g.ny, minX: g.minX, minY: g.minY, dx: g.dx, dy: g.dy, minZ: g.minZ, stride: settings.exportStride, heights: g.heights });
      if (!res.ok) throw new Error(res.message);
      rt.toast(`Wrote ${res.data.path} (${res.data.triangles} triangles, ${rt.formatBytes(res.data.bytes)})`, { kind: "success", duration: 6000 });
    };
    const s = cmp?.stats;
    return (
      <>
        <h3>Final geometry</h3>
        {!globalThis.__usermodSimRuntimes ? <Err>The simulation-runtime patch is missing: re-run the installer.</Err> : null}
        {!r ? <Sub>Open the Preview tab; the simulation runtime appears with the 3D preview.</Sub> : null}
        {r && !ready ? <Sub>Turn on the material simulation view in the Preview tab, then compute.</Sub> : null}
        <Row>
          <Input type="number" label="Tolerance (mm)" value={tol} onChange={setTol} step={0.05} />
          <Toggle label="Hide stock outside the model footprint" checked={hideOutside} onChange={setHideOutside} />
        </Row>
        <Row>
          <Button label={cmp ? "Recompute" : "Compute final geometry"} primary disabled={!ready || busy} onClick={compute} />
          <Button label="Export machined stock (STL)…" disabled={!cmp || busy} onClick={exportStl} />
          <Button
            label="Remove overlay"
            disabled={!built}
            onClick={() => {
              disposeBuilt();
              setCmp(null);
              rerender();
            }}
          />
        </Row>
        {error ? <Err>{error}</Err> : null}
        {log.length ? <Sub>{log[log.length - 1]}</Sub> : null}
        {s ? (
          <>
            <KV
              pairs={[
                ["Grid", `${cmp!.grid.nx} × ${cmp!.grid.ny} columns at ${s.resolution.toFixed(2)} mm`],
                ["Under the model", `${s.footprint} columns · ${s.footprint ? ((100 * s.withinTol) / s.footprint).toFixed(1) : "0"}% within ±${tol} mm`],
                ["Rest material", <span className={s.maxRest > Number(tol) ? "usermod-err" : "usermod-ok"}>{`${fmtVol(s.restVolume)} · deepest ${s.maxRest.toFixed(2)} mm`}</span>],
                ["Overcut", <span className={s.maxGouge > Number(tol) ? "usermod-err" : "usermod-ok"}>{`${fmtVol(s.gougeVolume)} · deepest ${s.maxGouge.toFixed(2)} mm`}</span>],
                ["Stock left outside the model", fmtVol(s.outsideVolume)]
              ]}
            />
            <Toggle
              label="Show original model as a ghost"
              checked={showGhost}
              onChange={(on) => {
                setShowGhost(on);
                applyVisibility(built, on, hideStock, hideModels);
              }}
            />
            <Toggle
              label="Hide the app's machined stock"
              checked={hideStock}
              onChange={(on) => {
                setHideStock(on);
                applyVisibility(built, showGhost, on, hideModels);
              }}
            />
            <Toggle
              label="Hide the app's model"
              checked={hideModels}
              onChange={(on) => {
                setHideModels(on);
                applyVisibility(built, showGhost, hideStock, on);
              }}
            />
            <Sub>Green: within tolerance. Yellow to red: material left standing. Blue: cut into the model. Grey: stock outside the model footprint. Vertical comparison, one face at a time.</Sub>
          </>
        ) : null}
      </>
    );
  }

  ui.toolbar.addButton({
    id: "final-geometry",
    title: "Final geometry (machined result vs model)",
    icon: () => ui.icons.svg("M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.2 6.6 3.3L12 10.8 5.4 7.5 12 4.2zM5 9.1l6 3v7.4l-6-3V9.1zm14 0v7.4l-6 3v-7.4l6-3zM16.5 12.2l-2.3 2.6-1-1-.9.9 1.9 1.9 3.2-3.5-.9-.9z"),
    order: 49,
    onClick: (button) => {
      ui.react.popover(button, <Panel />, { width: 460 });
    }
  });
})();
