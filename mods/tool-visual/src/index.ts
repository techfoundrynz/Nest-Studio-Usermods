/*
 * Tool visual: the preview's cutter is a single STL bit (about 3.2 mm across after the app scales it) that is
 * only moved and spun, whatever tool a toolpath actually uses. The stock-removal simulation, however, gets
 * per-path tool metadata (diameter, type, shank, tip angle) and the timeline knows which toolpath each sample
 * belongs to. This mod hooks the simulation runtime the installer exposes (globalThis.__usermodSimRuntimes),
 * remembers the tool map when the app resets stock removal, and on every seek scales the cutter model to the
 * diameter of the tool for the current sample.
 *
 * mods.json settings ("tool-visual"):
 *   scaleLength       also scale the bit's length with its diameter (default true)
 *   minLengthScale    lower clamp for the length scale                    (default 0.6)
 *   maxLengthScale    upper clamp for the length scale                    (default 2.5)
 *   hideWhenUnknown   hide the cutter when the current path has no tool diameter (default false)
 */
(function toolVisual(): void {
  const rt = window.usermodRuntime;
  rt.register({ name: "tool-visual", version: "0.1.0" });

  interface Settings {
    scaleLength: boolean;
    minLengthScale: number;
    maxLengthScale: number;
    hideWhenUnknown: boolean;
  }
  let settings: Settings = { scaleLength: true, minLengthScale: 0.6, maxLengthScale: 2.5, hideWhenUnknown: false };
  void window.usermod.info().then((r) => {
    if (!r.ok) return;
    const m = r.data.config.settings["tool-visual"] ?? {};
    settings = {
      scaleLength: m.scaleLength !== false,
      minLengthScale: Number(m.minLengthScale ?? 0.6) || 0.6,
      maxLengthScale: Number(m.maxLengthScale ?? 2.5) || 2.5,
      hideWhenUnknown: m.hideWhenUnknown === true
    };
  });

  interface Hooked {
    tools: Map<string, UsermodToolMeta>;
    lastGcodeId: string | null;
    baseDiameter: number | null;
  }
  const hooked = new WeakMap<UsermodSimRuntimeLike, Hooked>();
  let lastReport = "";

  function baseDiameterOf(runtime: UsermodSimRuntimeLike, state: Hooked): number | null {
    if (state.baseDiameter) return state.baseDiameter;
    const box = runtime.cuttingTool?.mesh?.geometry.boundingBox;
    if (!box) return null;
    const d = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
    if (!(d > 0)) return null;
    state.baseDiameter = d;
    return d;
  }

  function applyForSample(runtime: UsermodSimRuntimeLike, state: Hooked, sampleIndex: number): void {
    const tool = runtime.cuttingTool;
    if (!tool) return;
    const gcodeId = runtime.getSpatialGcodeIds()[Math.max(0, Math.floor(sampleIndex))] ?? null;
    if (gcodeId === state.lastGcodeId) return;
    state.lastGcodeId = gcodeId;
    const meta = gcodeId ? state.tools.get(gcodeId) : undefined;
    const base = baseDiameterOf(runtime, state);
    const diameter = meta?.diameter;
    if (!base || !diameter || !(diameter > 0)) {
      tool.root.scale.set(1, 1, 1);
      if (settings.hideWhenUnknown) tool.root.visible = false;
      runtime.manager.requestRender();
      return;
    }
    const radial = diameter / base;
    const length = settings.scaleLength ? Math.min(settings.maxLengthScale, Math.max(settings.minLengthScale, radial)) : 1;
    // The app translates the bit so its tip sits at the origin; scaling the root keeps the tip on the path.
    tool.root.scale.set(radial, radial, length);
    runtime.manager.requestRender();
    const report = `${gcodeId}:${diameter}`;
    if (report !== lastReport) {
      lastReport = report;
      rt.log("info", `cutter sized for ${meta?.toolType ?? "tool"} Ø${diameter} mm (x${radial.toFixed(2)})`);
    }
  }

  function hook(runtime: UsermodSimRuntimeLike): void {
    if (hooked.has(runtime)) return;
    const state: Hooked = { tools: new Map(), lastGcodeId: null, baseDiameter: null };
    hooked.set(runtime, state);
    const originals = {
      resetStockRemoval: runtime.resetStockRemoval,
      seekSpatialSample: runtime.seekSpatialSample,
      seekStockRemoval: runtime.seekStockRemoval
    };
    runtime.resetStockRemoval = (toolsByGcodeId) => {
      state.tools = new Map(toolsByGcodeId);
      state.lastGcodeId = null;
      return originals.resetStockRemoval.call(runtime, toolsByGcodeId);
    };
    runtime.seekSpatialSample = (sampleIndex) => {
      const result = originals.seekSpatialSample.call(runtime, sampleIndex);
      try {
        applyForSample(runtime, state, sampleIndex);
      } catch (error) {
        rt.log("warn", `tool-visual: ${error instanceof Error ? error.message : String(error)}`);
      }
      return result;
    };
    runtime.seekStockRemoval = (sampleIndex, options) => {
      originals.seekStockRemoval.call(runtime, sampleIndex, options);
      try {
        applyForSample(runtime, state, sampleIndex);
      } catch (error) {
        rt.log("warn", `tool-visual: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    rt.log("info", "tool-visual hooked a simulation runtime");
  }

  // Runtimes are created when a 3D preview mounts; pick them up as they appear.
  setInterval(() => {
    const runtimes = globalThis.__usermodSimRuntimes;
    if (!runtimes) return;
    for (const runtime of runtimes) hook(runtime);
  }, 500);

  rt.menu.addAction({
    id: "tool-visual",
    label: "Cutter model…",
    section: "Appearance",
    order: 40,
    onClick: ({ close }) => {
      close();
      const ui = window.usermodUI;
      const modal = ui.modal("Cutter model", { width: 440 });
      const patched = Boolean(globalThis.__usermodSimRuntimes);
      modal.body.append(
        rt.el("div", { class: "usermod-sub", text: patched ? `Simulation runtimes seen: ${globalThis.__usermodSimRuntimes?.size ?? 0}. The cutter follows each toolpath's tool diameter during simulation.` : "Simulation runtime access is not patched in; re-run the installer." }),
        ui.settingsForm("tool-visual", {
          title: "Settings",
          reloadPostprocessors: false,
          fields: [
            { key: "scaleLength", label: "Scale the bit's length with its diameter", type: "boolean" },
            { key: "minLengthScale", label: "Minimum length scale", type: "number", min: 0.1, max: 1, step: 0.1 },
            { key: "maxLengthScale", label: "Maximum length scale", type: "number", min: 1, max: 5, step: 0.1 },
            { key: "hideWhenUnknown", label: "Hide the cutter when the path has no tool diameter", type: "boolean" }
          ],
          onSaved: (v) => {
            settings = { scaleLength: v.scaleLength !== false, minLengthScale: Number(v.minLengthScale) || 0.6, maxLengthScale: Number(v.maxLengthScale) || 2.5, hideWhenUnknown: v.hideWhenUnknown === true };
          }
        })
      );
    }
  });
})();
