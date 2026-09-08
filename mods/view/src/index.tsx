/*
 * View: how the 3D scene is drawn, in one window with a tab per concern.
 *
 * One window, both parts of it.
 *
 * Camera: switch between the app's perspective camera and an isometric-style projection (a very narrow field
 * of view at a scaled distance, so the app's own orbit, zoom and pan keep working), and jump to Top / Front /
 * Right / Back / Left / Iso or reset. Toolpath colour: repaint the preview's paths by Z depth or per operation
 * and dim everything except the path under the mouse in the toolpath list.
 *
 * Both read the app's three.js scene through the installer's scene patch (globalThis.__usermodSceneManagers).
 * mods.json settings ("view"): fovDegrees (isometric field of view, default 6), mode ("depth" | "path" | "off"),
 *   highlight (true)
 */
(function view(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "view", version: "0.1.0" });

  /** A section renders into `body` and may return a cleanup function (React panels return their unmount). */
  interface Section {
    label: string;
    open(body: HTMLElement, close: () => void): void | (() => void);
  }
  const sections: Section[] = [];
  /** Features share the one toolbar button: the camera marks the isometric projection as active on it. */
  let handle: Usermod.ToolbarButtonHandle | null = null;
  const setBadge = (on: boolean): void => handle?.setBadge(on);

  (function feature(): void {
      const rt = window.usermodRuntime;
      const ui = window.usermodUI;

      const DEFAULT_FOV = 50;
      let isoFov = 6;
      void window.usermod.info().then((r) => {
        if (r.ok) isoFov = Number(r.data.config.settings["iso-view"]?.fovDegrees) || 6;
      });

      /** Per-manager memory of the perspective state we replaced. */
      interface SavedView {
        fov: number;
        near: number;
        far: number;
        minDistance: number;
        maxDistance: number;
        panSensitivity: number;
        factor: number;
        applySnapshot: UsermodCameraControllerLike["applySnapshot"];
        saveState: UsermodCameraControllerLike["saveState"];
        getSnapshot: UsermodCameraControllerLike["getSnapshot"];
      }
      const saved = new WeakMap<UsermodSceneManagerLike, SavedView>();

      function activeManager(): UsermodSceneManagerLike | null {
        const managers = globalThis.__usermodSceneManagers;
        if (!managers) return null;
        const live = [...managers].filter((m) => !m.disposed && m.renderer?.domElement?.isConnected);
        // Prefer the one on screen (largest visible canvas).
        live.sort((a, b) => area(b.renderer.domElement) - area(a.renderer.domElement));
        return live[0] ?? null;
      }
      const area = (el: HTMLElement): number => {
        const r = el.getBoundingClientRect();
        return r.width * r.height;
      };

      function lookFrom(manager: UsermodSceneManagerLike, dir: [number, number, number]): void {
        const c = manager.cameraController;
        const camera = c.camera;
        const offset = c.target.clone().set(dir[0], dir[1], dir[2]).normalize().multiplyScalar(c.distance);
        camera.position.copy(c.target.clone().add(offset));
        camera.up.set(0, 0, 1);
        camera.lookAt(c.target);
        c.viewQuat.copy(camera.quaternion);
        c.updateCamera();
        c.emit?.("change");
        manager.requestRender();
      }
      /**
       * A narrow FOV needs the camera ~9x further away for the same framing, so everything expressed as a
       * distance has to scale with it: the controller's wheel-zoom clamp (min/maxDistance) and the camera's
       * near/far planes. Otherwise iso mode can only zoom out to a ninth of the perspective range and the far
       * plane clips the scene first.
       */
      function setIso(manager: UsermodSceneManagerLike, on: boolean): void {
        const c = manager.cameraController;
        const camera = c.camera;
        const tan = (deg: number): number => Math.tan((deg * Math.PI) / 360);
        if (on && !saved.has(manager)) {
          const factor = tan(camera.fov) / tan(isoFov);
          const originals = { applySnapshot: c.applySnapshot, saveState: c.saveState, getSnapshot: c.getSnapshot };
          saved.set(manager, {
            fov: camera.fov,
            near: camera.near,
            far: camera.far,
            minDistance: c.config.minDistance,
            maxDistance: c.config.maxDistance,
            panSensitivity: c.config.panSensitivity,
            factor,
            ...originals
          });
          c.config.minDistance *= factor;
          c.config.maxDistance *= factor;
          c.config.panSensitivity /= factor; // pan step is distance * sensitivity: keep screen-space speed unchanged
          c.distance *= factor;
          camera.near *= factor;
          camera.far *= factor;
          camera.fov = isoFov;
          camera.updateProjectionMatrix();
          // The app (fit / reset / presets / per-project camera memory) thinks in perspective distances.
          // Convert on the way in and out so its numbers stay valid while we run at iso scale.
          c.applySnapshot = (snapshot) => originals.applySnapshot.call(c, { ...snapshot, distance: snapshot.distance * factor });
          c.getSnapshot = () => {
            const snap = originals.getSnapshot.call(c);
            return { ...snap, distance: snap.distance / factor };
          };
          c.saveState = () => {
            const current = c.distance;
            c.distance = current / factor;
            originals.saveState.call(c);
            c.distance = current;
          };
          lookFrom(manager, [1, -1, 1]);
        } else if (!on && saved.has(manager)) {
          const prev = saved.get(manager)!;
          c.applySnapshot = prev.applySnapshot;
          c.saveState = prev.saveState;
          c.getSnapshot = prev.getSnapshot;
          c.config.minDistance = prev.minDistance;
          c.config.maxDistance = prev.maxDistance;
          c.config.panSensitivity = prev.panSensitivity;
          c.distance = Math.min(prev.maxDistance, Math.max(prev.minDistance, c.distance / prev.factor));
          camera.near = prev.near;
          camera.far = prev.far;
          camera.fov = prev.fov;
          camera.updateProjectionMatrix();
          c.updateCamera();
          c.emit?.("change");
          manager.requestRender();
          saved.delete(manager);
        }
        setBadge(saved.has(manager));
      }
      const isIso = (manager: UsermodSceneManagerLike): boolean => saved.has(manager);

      function noScene(): void {
        rt.toast(globalThis.__usermodSceneManagers ? "No 3D scene on this page" : "3D scene access is not patched in; re-run the installer", { kind: "warn" });
      }

      /** The Camera tab: view presets and the projection switch, rendered into the tab body. */
      const cameraPanel = (body: HTMLElement): void => {
        const manager = activeManager();
        if (!manager) return noScene();
        const view = (label: string, dir: [number, number, number]) => ui.button(label, () => lookFrom(manager, dir));
        body.append(
          rt.el("h3", { text: "View" }),
          ui.buttonRow([view("Top", [0, 0, 1]), view("Front", [0, -1, 0]), view("Right", [1, 0, 0]), view("Back", [0, 1, 0]), view("Left", [-1, 0, 0]), view("Iso", [1, -1, 1])]),
          ui.buttonRow([
            ui.button(isIso(manager) ? "Perspective projection" : "Isometric projection", () => {
              setIso(manager, !isIso(manager));
            }, { primary: true }),
            ui.button("Reset camera", () => {
              if (isIso(manager)) setIso(manager, false);
              manager.cameraController.reset();
              manager.requestRender();
            })
          ])
        );
      };
    sections.push({ label: "Camera", open: (body) => cameraPanel(body) });
  })();

  (function feature(): void {
      const rt = window.usermodRuntime;
      const ui = window.usermodUI;
      const { Sub, Row, Button, Select, Toggle, KV, useInfo } = ui.react;

      type Mode = "depth" | "path" | "off";
      let mode: Mode = "depth";
      let highlightEnabled = true;
      const GROUP = "previewGcodeGroup";
      const RAPID_HEX = "#cda28a"; // the app's G0 colour (parse worker GCODE_TOOL_COLOR_HEX.G0)

      /* ------------------------------------------------------------- colours */
      type RGB = [number, number, number];
      const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const hexToLinear = (hex: string): RGB => {
        const n = parseInt(hex.slice(1), 16);
        return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
      };
      const RAPID = hexToLinear(RAPID_HEX);
      const PATH_PALETTE = ["#13aa45", "#4889ff", "#7749fa", "#eb52a0", "#f59e0b", "#06b6d4", "#84cc16", "#ef4444", "#a855f7", "#14b8a6"].map(hexToLinear);
      /** Depth ramp in sRGB: green → yellow → orange → red, then converted to linear. */
      const ramp = (t: number): RGB => {
        const stops: [number, RGB][] = [
          [0, [0.15, 0.75, 0.3]],
          [0.4, [0.95, 0.85, 0.15]],
          [0.7, [0.98, 0.5, 0.1]],
          [1, [0.9, 0.1, 0.1]]
        ];
        const x = Math.min(1, Math.max(0, t));
        for (let i = 1; i < stops.length; i += 1) {
          const [t0, c0] = stops[i - 1]!;
          const [t1, c1] = stops[i]!;
          if (x <= t1) {
            const k = (x - t0) / (t1 - t0);
            return [srgbToLinear(c0[0] + (c1[0] - c0[0]) * k), srgbToLinear(c0[1] + (c1[1] - c0[1]) * k), srgbToLinear(c0[2] + (c1[2] - c0[2]) * k)];
          }
        }
        return [srgbToLinear(0.9), srgbToLinear(0.1), srgbToLinear(0.1)];
      };

      /* ------------------------------------------------------- scene access */
      type ColorArray = Uint8Array | Float32Array;
      interface Painted {
        original: ColorArray;
        byte: boolean;
      }
      const painted = new WeakMap<UsermodGeometryLike, Painted>();
      const lineTool = new WeakMap<UsermodObject3DLike, string>();

      function managers(): UsermodSceneManagerLike[] {
        return [...(globalThis.__usermodSceneManagers ?? [])].filter((m) => !m.disposed);
      }
      function toolpathLines(mgr: UsermodSceneManagerLike): UsermodObject3DLike[] {
        const out: UsermodObject3DLike[] = [];
        mgr.scene.traverse((o) => {
          if (o.name === GROUP) for (const child of o.children) if (child.geometry && typeof child.userData.gcodeId === "string") out.push(child);
        });
        return out;
      }
      function colorArray(geometry: UsermodGeometryLike): { attr: UsermodBufferAttributeLike; arr: ColorArray } | null {
        const attr = geometry.getAttribute("color");
        if (!attr) return null;
        const arr = attr.array;
        if (arr instanceof Uint8Array || arr instanceof Float32Array) return { attr, arr };
        return null;
      }
      function remember(geometry: UsermodGeometryLike): Painted | null {
        const cur = painted.get(geometry);
        if (cur) return cur;
        const c = colorArray(geometry);
        if (!c) return null;
        const entry: Painted = { original: c.arr instanceof Uint8Array ? Uint8Array.from(c.arr) : Float32Array.from(c.arr), byte: c.arr instanceof Uint8Array };
        painted.set(geometry, entry);
        return entry;
      }
      const readOriginal = (p: Painted, i: number): RGB => {
        const o = i * 3;
        const k = p.byte ? 1 / 255 : 1;
        return [(p.original[o] ?? 0) * k, (p.original[o + 1] ?? 0) * k, (p.original[o + 2] ?? 0) * k];
      };
      const isRapid = (c: RGB): boolean => Math.abs(c[0] - RAPID[0]) < 0.02 && Math.abs(c[1] - RAPID[1]) < 0.02 && Math.abs(c[2] - RAPID[2]) < 0.02;
      function write(geometry: UsermodGeometryLike, color: (i: number, original: RGB) => RGB): void {
        const p = remember(geometry);
        const c = colorArray(geometry);
        if (!p || !c) return;
        const count = Math.floor(c.arr.length / 3);
        for (let i = 0; i < count; i += 1) {
          const [r, g, b] = color(i, readOriginal(p, i));
          const o = i * 3;
          if (c.arr instanceof Uint8Array) {
            c.arr[o] = Math.round(Math.min(1, r) * 255);
            c.arr[o + 1] = Math.round(Math.min(1, g) * 255);
            c.arr[o + 2] = Math.round(Math.min(1, b) * 255);
          } else {
            c.arr[o] = r;
            c.arr[o + 1] = g;
            c.arr[o + 2] = b;
          }
        }
        c.attr.needsUpdate = true;
      }
      function zRange(lines: UsermodObject3DLike[]): [number, number] {
        let min = Infinity;
        let max = -Infinity;
        for (const line of lines) {
          const pos = line.geometry?.getAttribute("position");
          const p = line.geometry ? remember(line.geometry) : null;
          if (!pos || !p) continue;
          const count = Math.floor(pos.array.length / 3);
          for (let i = 0; i < count; i += 1) {
            if (isRapid(readOriginal(p, i))) continue;
            const z = pos.array[i * 3 + 2] ?? 0;
            if (z < min) min = z;
            if (z > max) max = z;
          }
        }
        return Number.isFinite(min) && max > min ? [min, max] : [0, 0];
      }
      /** Tool label per gcode id from the Preview tab's own list rows ("T2~6mm"). */
      function toolOf(gcodeId: string): string {
        const row = document.querySelector(`[data-gcode-id="${gcodeId.replace(/"/g, '\\"')}"]`);
        const m = row ? /\bT(\d+)/.exec(row.textContent ?? "") : null;
        return m ? `T${m[1]}` : "";
      }

      let lastRange: [number, number] = [0, 0];
      let pathColors = new Map<string, number>();
      function apply(hover: string | null = null): void {
        for (const mgr of managers()) {
          const lines = toolpathLines(mgr);
          if (!lines.length) continue;
          if (mode === "depth") lastRange = zRange(lines);
          const ids = lines.map((l) => String(l.userData.gcodeId));
          for (const id of ids) if (!pathColors.has(id)) pathColors.set(id, pathColors.size % PATH_PALETTE.length);
          const [zMin, zMax] = lastRange;
          for (const line of lines) {
            const geometry = line.geometry;
            if (!geometry) continue;
            const id = String(line.userData.gcodeId);
            lineTool.set(line, toolOf(id));
            const pos = geometry.getAttribute("position");
            const dim = hover !== null && hover !== id;
            const pathColor = PATH_PALETTE[pathColors.get(id) ?? 0]!;
            write(geometry, (i, original) => {
              let c: RGB = original;
              if (!isRapid(original)) {
                if (mode === "depth" && pos && zMax > zMin) c = ramp((zMax - (pos.array[i * 3 + 2] ?? zMax)) / (zMax - zMin));
                else if (mode === "path") c = pathColor;
              }
              return dim ? [c[0] * 0.12 + 0.02, c[1] * 0.12 + 0.02, c[2] * 0.12 + 0.02] : c;
            });
          }
          mgr.requestRender();
        }
      }

      // Re-apply when the app (re)builds toolpath geometry: cheap signature poll.
      let signature = "";
      let hovered: string | null = null;
      setInterval(() => {
        const sig = managers()
          .map((m) => toolpathLines(m).map((l) => `${String(l.userData.gcodeId)}:${painted.has(l.geometry!) ? "p" : "n"}`).join(","))
          .join("|");
        if (sig !== signature) {
          signature = sig;
          if (mode !== "off" || hovered) apply(hovered);
        }
      }, 1000);
      document.addEventListener("mouseover", (e) => {
        if (!highlightEnabled) return;
        const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-gcode-id]") : null;
        const id = row?.dataset.gcodeId ?? null;
        if (id === hovered) return;
        hovered = id;
        apply(hovered);
      });
      document.addEventListener("mouseleave", () => {
        if (hovered) {
          hovered = null;
          apply(null);
        }
      }, true);

      void window.usermod.info().then((r) => {
        if (!r.ok) return;
        const s = r.data.config.settings["toolpath-color"] ?? {};
        mode = s.mode === "path" || s.mode === "off" ? s.mode : "depth";
        highlightEnabled = s.highlight !== false;
        apply();
      });

      function Panel(): React.JSX.Element {
        const [, force] = React.useState(0);
        const { data: info } = useInfo();
        const setMode = async (m: Mode): Promise<void> => {
          mode = m;
          apply(hovered);
          force((n) => n + 1);
          await window.usermod.setSettings("toolpath-color", { ...(info?.config.settings["toolpath-color"] ?? {}), mode: m, highlight: highlightEnabled });
        };
        const setHighlight = async (on: boolean): Promise<void> => {
          highlightEnabled = on;
          if (!on && hovered) {
            hovered = null;
            apply(null);
          }
          force((n) => n + 1);
          await window.usermod.setSettings("toolpath-color", { ...(info?.config.settings["toolpath-color"] ?? {}), mode, highlight: on });
        };
        const lines = managers().flatMap(toolpathLines);
        const tools = [...new Set(lines.map((l) => lineTool.get(l) ?? ""))].filter(Boolean);
        return (
          <>
            <h3>Toolpath colour</h3>
            <Select label="Colour by" options={[{ value: "depth", label: "Depth (green → red)" }, { value: "path", label: "Operation (one colour per path)" }, { value: "off", label: "App default (by tool)" }]} value={mode} onChange={(v) => void setMode(v === "path" || v === "off" ? v : "depth")} />
            <Toggle label="Highlight the path under the mouse in the list" checked={highlightEnabled} onChange={(on) => void setHighlight(on)} />
            <KV
              pairs={[
                ["Toolpaths in scene", String(lines.length)],
                ["Tools", tools.join(", ") || "—"],
                ["Depth range", mode === "depth" && lastRange[1] > lastRange[0] ? `Z ${lastRange[0].toFixed(2)} … ${lastRange[1].toFixed(2)} (red = deepest)` : "—"],
                ["Scene patch", globalThis.__usermodSceneManagers ? "present" : "missing: re-run the installer"]
              ]}
            />
            <Sub>Rapids keep the app's tan colour. Colours are re-applied when paths reload; the app's machining progress overlay still paints executed segments grey.</Sub>
            <Row>
              <Button label="Re-apply" onClick={() => apply(hovered)} />
            </Row>
          </>
        );
      }
    sections.push({ label: "Toolpath colour", open: (body) => ui.react.mount(body, <Panel />) });
  })();

  rt.addStyle(`.usermod-view-section{margin-top:14px}.usermod-view-section:first-child{margin-top:0}`, "view-sections");
  /** Everything in one window: the camera controls and the colouring, one under the other. */
  function openWindow(): void {
    const cleanups: (() => void)[] = [];
    const modal = ui.modal("View", {
      width: 460,
      onClose: () => {
        for (const cleanup of cleanups) cleanup();
      }
    });
    for (const section of sections) {
      const body = rt.el("div", { class: "usermod-view-section" });
      modal.body.append(rt.el("h4", { text: section.label }), body);
      const cleanup = section.open(body, modal.close);
      if (typeof cleanup === "function") cleanups.push(cleanup);
    }
  }

  handle = ui.toolbar.addButton({
    id: "view",
    title: "3D view options",
    icon: () => ui.icons.svg("M12 2.5 3.5 7.25v9.5L12 21.5l8.5-4.75v-9.5L12 2.5zm0 2.3 6 3.35-6 3.35-6-3.35 6-3.35zM5.5 9.1l5.5 3.07v6.63L5.5 15.7V9.1zm13 0v6.6l-5.5 3.1v-6.63L18.5 9.1z"),
    order: 12,
    onClick: () => openWindow()
  });
})();
