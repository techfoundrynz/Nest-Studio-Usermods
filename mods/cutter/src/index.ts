/*
 * Tool visual: Nest Studio's preview draws one fixed STL bit (about 3.2 mm across) for every toolpath, only
 * moving and spinning it. This mod replaces the cutter geometry with a procedurally built tool that matches
 * the toolpath being simulated: flat end mill, ball nose, tapered / V bit, drill or chamfer, using the
 * diameter, flute length, shank diameter, total length and taper angle from your tool library.
 *
 * Data sources, in order: the tool map the app hands the scene when material simulation is active; the
 * preview's toolpath list (rows carry data-gcode-id and a "T2~6mm" label); the tool library in the user
 * store (slot number -> type / lengths / shank). The hook point is the simulation runtime the installer
 * exposes (globalThis.__usermodSimRuntimes); geometry is swapped on the app's own cutter mesh, so its
 * material, spin and positioning are untouched.
 *
 * mods.json settings ("cutter"):
 *   maxLengthMm       cap on the drawn tool length                                (default 60)
 *   minDiameterMm     draw very small tips at least this wide so they stay visible (default 0.6)
 *   hideWhenUnknown   hide the cutter when the current path has no tool data      (default false)
 */
(function toolVisual(): void {
  const rt = window.usermodRuntime;
  rt.register({ name: "cutter", version: "0.2.0" });

  interface Settings {
    maxLengthMm: number;
    minDiameterMm: number;
    hideWhenUnknown: boolean;
  }
  let settings: Settings = { maxLengthMm: 60, minDiameterMm: 0.6, hideWhenUnknown: false };
  const loadSettings = (): void => {
    void window.usermod.info().then((r) => {
      if (!r.ok) return;
      const m = r.data.config.settings["cutter"] ?? {};
      settings = { maxLengthMm: Number(m.maxLengthMm ?? 60) || 60, minDiameterMm: Number(m.minDiameterMm ?? 0.6) || 0.6, hideWhenUnknown: m.hideWhenUnknown === true };
    });
  };
  loadSettings();

  /* ------------------------------------------------------------ tool model */
  type Kind = "flat" | "ball" | "cone" | "drill";
  interface ToolSpec {
    kind: Kind;
    diameter: number;
    fluteLength: number;
    shankDiameter: number;
    totalLength: number;
    /** Included taper / point angle in degrees (cone, drill). */
    angle: number;
    label: string;
  }
  const kindOf = (text: string | undefined): Kind => {
    const t = (text ?? "").toLowerCase();
    if (/ball|球/.test(t)) return "ball";
    if (/drill|钻/.test(t)) return "drill";
    if (/tap|cone|taper|v-?bit|chamfer|engrav|锥|倒角/.test(t)) return "cone";
    return "flat";
  };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : typeof v === "string" && Number(v) > 0 ? Number(v) : undefined);

  /* Tool library (slot -> tool) from the user store, refreshed every 10 s on demand. */
  let library = new Map<number, NestStudio.Tool>();
  let libraryAt = 0;
  async function refreshLibrary(): Promise<void> {
    if (Date.now() - libraryAt < 10000) return;
    libraryAt = Date.now();
    try {
      const store = await window.api.store.read();
      if (!store.ok) return;
      const next = new Map<number, NestStudio.Tool>();
      for (const tool of store.data.toolLibary?.cutLibrarySettings ?? []) next.set(Number(tool.slotNum), tool);
      library = next;
    } catch {
      /* keep the previous library */
    }
  }

  /* Toolpath list rows: gcodeId -> { toolNum, diameter, typeText }. Rebuilt when a lookup misses. */
  interface RowInfo {
    toolNum: number | null;
    diameter: number | null;
    typeText: string;
  }
  let rows = new Map<string, RowInfo>();
  function refreshRows(): void {
    const next = new Map<string, RowInfo>();
    for (const row of document.querySelectorAll<HTMLElement>("[data-gcode-id]")) {
      const id = row.dataset.gcodeId;
      if (!id) continue;
      const text = row.textContent ?? "";
      const m = /T(\d+)(?:~([\d.]+)\s*mm)?/.exec(text);
      next.set(id, { toolNum: m ? Number(m[1]) : null, diameter: m?.[2] ? Number(m[2]) : null, typeText: text });
    }
    rows = next;
  }

  function specFor(gcodeId: string, sceneMeta: UsermodToolMeta | undefined): ToolSpec | null {
    if (!rows.has(gcodeId)) refreshRows();
    const row = rows.get(gcodeId);
    const lib = row?.toolNum !== null && row?.toolNum !== undefined ? library.get(row.toolNum) : undefined;
    const diameter = num(sceneMeta?.diameter) ?? num(lib?.diameter) ?? row?.diameter ?? undefined;
    if (!diameter) return null;
    const kind = kindOf(typeof lib?.type === "string" ? lib.type : row?.typeText ?? sceneMeta?.toolType);
    const fluteLength = num(sceneMeta?.bladeLength) ?? num(lib?.bladeLength) ?? diameter * 3;
    const shankDiameter = num(sceneMeta?.shankDiameter) ?? num(lib?.toolShankDiameter) ?? Math.max(diameter, 3.175);
    const totalLength = Math.min(settings.maxLengthMm, num(lib?.totalLength) ?? fluteLength * 2.2);
    const angle = num(sceneMeta?.tipAngleDeg) ?? num(lib?.angle) ?? (kind === "drill" ? 118 : kind === "cone" ? 30 : 0);
    const label = `${kind} T${row?.toolNum ?? "?"} Ø${diameter}${lib?.name ? ` ${String(lib.name)}` : ""}`;
    return { kind, diameter, fluteLength, shankDiameter, totalLength: Math.max(totalLength, fluteLength + 2), angle, label };
  }

  /* ---------------------------------------------------------- geometry */
  /** Revolve an (r, z) profile around Z. Tip at z = 0 (the app positions the cutter by its tip). */
  function lathe(profile: [number, number][], GeometryCtor: UsermodGeometryCtor, AttributeCtor: UsermodAttributeCtor, segments = 40): UsermodGeometryLike {
    const positions: number[] = [];
    const index: number[] = [];
    for (let i = 0; i < profile.length; i += 1) {
      const [r, z] = profile[i]!;
      for (let j = 0; j <= segments; j += 1) {
        const a = (j / segments) * Math.PI * 2;
        positions.push(Math.cos(a) * r, Math.sin(a) * r, z);
      }
    }
    const ring = segments + 1;
    for (let i = 0; i < profile.length - 1; i += 1) {
      for (let j = 0; j < segments; j += 1) {
        const a = i * ring + j;
        const b = a + ring;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geometry = new GeometryCtor();
    geometry.setAttribute("position", new AttributeCtor(new Float32Array(positions), 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  }
  function profileFor(spec: ToolSpec): [number, number][] {
    const r = Math.max(spec.diameter, settings.minDiameterMm) / 2;
    const rs = Math.max(spec.shankDiameter / 2, r);
    const flute = Math.min(spec.fluteLength, spec.totalLength - 1);
    const total = spec.totalLength;
    const pts: [number, number][] = [];
    if (spec.kind === "ball") {
      const steps = 8;
      for (let i = 0; i <= steps; i += 1) {
        const t = (i / steps) * (Math.PI / 2);
        pts.push([Math.sin(t) * r, r - Math.cos(t) * r]);
      }
      pts.push([r, flute]);
    } else if (spec.kind === "cone" || spec.kind === "drill") {
      const half = (Math.min(Math.max(spec.angle, 2), 178) * Math.PI) / 360;
      if (spec.kind === "drill") {
        const tipH = r / Math.tan(half);
        pts.push([0, 0], [r, tipH], [r, flute]);
      } else {
        // Tapered tools: the diameter is the tip; grow with the taper angle to the flute length or the shank.
        const tipR = Math.max(spec.diameter, settings.minDiameterMm) / 2;
        const growth = Math.tan(half) * flute;
        const topR = Math.min(rs, tipR + growth);
        pts.push([tipR, 0], [topR, flute]);
      }
    } else {
      pts.push([0, 0], [r, 0], [r, flute]);
    }
    // Shoulder up to the shank, then the shank to the total length; close the top.
    const shoulderTop = Math.min(flute + Math.max(rs - r, 0.5), total - 0.5);
    pts.push([rs, shoulderTop], [rs, total], [0, total]);
    return pts;
  }

  /* -------------------------------------------------------------- runtime */
  interface Hooked {
    tools: Map<string, UsermodToolMeta>;
    lastGcodeId: string | null;
    original: UsermodGeometryLike | null;
    current: { key: string; geometry: UsermodGeometryLike } | null;
  }
  const hooked = new WeakMap<UsermodSimRuntimeLike, Hooked>();
  const warned = new Set<string>();

  function ctorsFrom(geometry: UsermodGeometryLike): { GeometryCtor: UsermodGeometryCtor; AttributeCtor: UsermodAttributeCtor } | null {
    const position = geometry.getAttribute("position");
    if (!position) return null;
    // The app's three.js classes are not importable here; the live geometry and attribute carry them.
    const GeometryCtor = (Object.getPrototypeOf(geometry) as { constructor: unknown }).constructor as UsermodGeometryCtor;
    const AttributeCtor = (Object.getPrototypeOf(position) as { constructor: unknown }).constructor as UsermodAttributeCtor;
    return { GeometryCtor, AttributeCtor };
  }

  function restore(runtime: UsermodSimRuntimeLike, state: Hooked): void {
    const mesh = runtime.cuttingTool?.mesh;
    if (mesh && state.original && mesh.geometry !== state.original) mesh.geometry = state.original;
    state.current?.geometry.dispose();
    state.current = null;
  }

  function applyForSample(runtime: UsermodSimRuntimeLike, state: Hooked, sampleIndex: number): void {
    const tool = runtime.cuttingTool;
    const mesh = tool?.mesh;
    if (!tool || !mesh) return; // bit STL still loading: retry on the next seek
    const gcodeId = runtime.getSpatialGcodeIds()[Math.max(0, Math.floor(sampleIndex))] ?? null;
    if (gcodeId === state.lastGcodeId) return;
    if (!state.original) state.original = mesh.geometry;
    void refreshLibrary();
    state.lastGcodeId = gcodeId;
    const spec = gcodeId ? specFor(gcodeId, state.tools.get(gcodeId)) : null;
    if (!spec) {
      restore(runtime, state);
      tool.root.scale.set(1, 1, 1);
      if (settings.hideWhenUnknown) tool.root.visible = false;
      runtime.manager.requestRender();
      if (gcodeId && !warned.has(gcodeId)) {
        warned.add(gcodeId);
        rt.log("warn", `cutter: no tool data for toolpath ${gcodeId} (scene map ${state.tools.size}, list rows ${rows.size}, library ${library.size}); default cutter kept`);
      }
      return;
    }
    const key = JSON.stringify([spec.kind, spec.diameter, spec.fluteLength, spec.shankDiameter, spec.totalLength, spec.angle]);
    if (state.current?.key !== key) {
      const ctors = ctorsFrom(state.original);
      if (!ctors) return;
      const geometry = lathe(profileFor(spec), ctors.GeometryCtor, ctors.AttributeCtor);
      state.current?.geometry.dispose();
      state.current = { key, geometry };
      mesh.geometry = geometry;
      rt.log("info", `cutter model: ${spec.label} (flute ${spec.fluteLength} mm, shank Ø${spec.shankDiameter}, length ${spec.totalLength.toFixed(0)} mm${spec.angle ? `, ${spec.angle}°` : ""})`);
    }
    tool.root.scale.set(1, 1, 1);
    tool.root.visible = true;
    runtime.manager.requestRender();
  }

  function hook(runtime: UsermodSimRuntimeLike): void {
    if (hooked.has(runtime)) return;
    const state: Hooked = { tools: new Map(), lastGcodeId: null, original: null, current: null };
    hooked.set(runtime, state);
    const originals = { resetStockRemoval: runtime.resetStockRemoval, seekSpatialSample: runtime.seekSpatialSample, seekStockRemoval: runtime.seekStockRemoval };
    const safely = (sampleIndex: number): void => {
      try {
        applyForSample(runtime, state, sampleIndex);
      } catch (error) {
        rt.log("warn", `cutter: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    runtime.resetStockRemoval = (toolsByGcodeId) => {
      state.tools = new Map(toolsByGcodeId);
      state.lastGcodeId = null;
      return originals.resetStockRemoval.call(runtime, toolsByGcodeId);
    };
    runtime.seekSpatialSample = (sampleIndex) => {
      const result = originals.seekSpatialSample.call(runtime, sampleIndex);
      safely(sampleIndex);
      return result;
    };
    runtime.seekStockRemoval = (sampleIndex, options) => {
      originals.seekStockRemoval.call(runtime, sampleIndex, options);
      safely(sampleIndex);
    };
    rt.log("info", "cutter hooked a simulation runtime");
  }
  setInterval(() => {
    for (const runtime of globalThis.__usermodSimRuntimes ?? []) hook(runtime);
  }, 500);

  window.usermodUI.toolbar.addButton({
    id: "cutter",
    title: "Cutter preview",
    icon: () => window.usermodUI.icons.svg("M9 2h6v9l3 4v7H6v-7l3-4V2zm2 2v6.3L8.5 14H12v-2h2v2h1.5L13 10.3V4h-2z"),
    order: 47,
    onClick: () => {
      const ui = window.usermodUI;
      const modal = ui.modal("Cutter model", { width: 460 });
      const patched = Boolean(globalThis.__usermodSimRuntimes);
      modal.body.append(
        rt.el("div", { class: "usermod-sub", text: patched ? `Simulation runtimes seen: ${globalThis.__usermodSimRuntimes?.size ?? 0}. The cutter is rebuilt per toolpath from the tool library (type, diameter, flute, shank, length).` : "Simulation runtime access is not patched in; re-run the installer." }),
        ui.settingsForm("cutter", {
          title: "Settings",
          reloadPostprocessors: false,
          fields: [
            { key: "maxLengthMm", label: "Maximum drawn tool length (mm)", type: "number", min: 10, max: 200, step: 5 },
            { key: "minDiameterMm", label: "Minimum drawn tip diameter (mm)", type: "number", min: 0.1, max: 3, step: 0.1, help: "Keeps tiny engraving tips visible." },
            { key: "hideWhenUnknown", label: "Hide the cutter when the path has no tool data", type: "boolean" }
          ],
          onSaved: () => loadSettings()
        })
      );
    }
  });
})();
