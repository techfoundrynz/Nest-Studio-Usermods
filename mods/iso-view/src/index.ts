/*
 * Iso view: a toolbar button that toggles the active 3D scene between the normal perspective camera and
 * an isometric-style view, plus a popover with view presets (Top / Front / Right / Iso / Reset).
 *
 * How: the installer exposes the app's SceneManager instances (globalThis.__usermodSceneManagers). The
 * camera is a three.js PerspectiveCamera driven by the app's CameraController (target + distance +
 * orientation quaternion). "Isometric" here means the classic equal-angle direction (1,-1,1) with a very
 * narrow field of view and the distance scaled up to keep framing, which looks orthographic while keeping
 * the app's own orbit/zoom/pan controls working. Toggling off restores the previous FOV and distance.
 *
 * mods.json settings ("iso-view"): fovDegrees (narrow FOV used in iso mode, default 6)
 */
(function isoView(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "iso-view", version: "0.1.0" });

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
    handle.setBadge(saved.has(manager));
  }
  const isIso = (manager: UsermodSceneManagerLike): boolean => saved.has(manager);

  function noScene(): void {
    rt.toast(globalThis.__usermodSceneManagers ? "No 3D scene on this page" : "3D scene access is not patched in; re-run the installer", { kind: "warn" });
  }

  const handle = ui.toolbar.addButton({
    id: "iso-view",
    title: "Isometric view (click: toggle, right-click: presets)",
    icon: () => ui.icons.svg("M12 2.5 3.5 7.25v9.5L12 21.5l8.5-4.75v-9.5L12 2.5zm0 2.3 6 3.35-6 3.35-6-3.35 6-3.35zM5.5 9.1l5.5 3.07v6.63L5.5 15.7V9.1zm13 0v6.6l-5.5 3.1v-6.63L18.5 9.1z"),
    order: 30,
    onClick: () => {
      const manager = activeManager();
      if (!manager) return noScene();
      setIso(manager, !isIso(manager));
      rt.toast(isIso(manager) ? "Isometric view" : "Perspective view", { duration: 1200 });
    }
  });
  const presets = (anchor: HTMLElement): void => {
    const manager = activeManager();
    if (!manager) return noScene();
    const pop = ui.popover(anchor, { width: 300 });
    const view = (label: string, dir: [number, number, number]) => ui.button(label, () => lookFrom(manager, dir));
    pop.body.append(
      rt.el("h3", { text: "View" }),
      ui.buttonRow([view("Top", [0, 0, 1]), view("Front", [0, -1, 0]), view("Right", [1, 0, 0]), view("Back", [0, 1, 0]), view("Left", [-1, 0, 0]), view("Iso", [1, -1, 1])]),
      ui.buttonRow([
        ui.button(isIso(manager) ? "Perspective projection" : "Isometric projection", () => {
          setIso(manager, !isIso(manager));
          pop.close();
        }, { primary: true }),
        ui.button("Reset camera", () => {
          if (isIso(manager)) setIso(manager, false);
          manager.cameraController.reset();
          manager.requestRender();
          pop.close();
        })
      ])
    );
  };
  // Right-click on the toolbar button opens the presets; the observer re-attaches after header remounts.
  const attachContextMenu = (): void => {
    const el = handle.element();
    if (el && !el.dataset.usermodIsoMenu) {
      el.dataset.usermodIsoMenu = "1";
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        presets(el);
      });
    }
  };
  attachContextMenu();
  rt.observe(attachContextMenu);
})();
