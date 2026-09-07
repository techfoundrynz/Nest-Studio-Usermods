/*
 * App tools: MODS menu actions backed by main/app-tools.ts (open log folders, CAM service status,
 * CAM API docs). Pure glue; the privileged work happens in the main-process mod.
 */
(function appToolsUi(): void {
  const rt = window.usermodRuntime;
  rt.register({ name: "app-tools", version: "0.2.0" });

  interface CamStatus {
    base: string;
    reachable: boolean;
    version: string | null;
    time: string | null;
    docs: boolean;
  }
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const r = await window.usermod.invoke<T>(channel, ...args);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  rt.menu.addAction({ id: "open-app-logs", label: "App logs", section: "Folders", order: 10, title: "Open Nest Studio's log folder", onClick: () => call("tools:open-logs") });
  rt.menu.addAction({ id: "open-userdata", label: "User data", section: "Folders", order: 20, title: "Open %APPDATA%\\Nest Studio", onClick: () => call("tools:open-userdata") });
  rt.menu.addAction({ id: "open-usermod-log", label: "usermod.log", section: "Folders", order: 30, title: "Open the mod loader log", onClick: () => call("tools:open-usermod-log") });

  rt.menu.addAction({
    id: "cam-status",
    label: "CAM service status",
    section: "CAM service",
    order: 10,
    onClick: async () => {
      const s = await call<CamStatus>("tools:cam-status");
      rt.toast(
        s.reachable ? `CAM ${s.version} (${s.time}) on ${s.base}. Docs ${s.docs ? "enabled" : "disabled (set ENABLE_DOCS=1)"}.` : `CAM service unreachable at ${s.base}`,
        { kind: s.reachable ? "success" : "error", duration: 6000 }
      );
    }
  });
  rt.menu.addAction({
    id: "cam-docs",
    label: "Open API docs",
    section: "CAM service",
    order: 20,
    title: "Swagger UI (only when the service runs with ENABLE_DOCS=1)",
    onClick: async () => {
      const s = await call<CamStatus>("tools:cam-status");
      if (!s.docs) {
        rt.toast("Swagger docs are off. Launch Nest Studio with ENABLE_DOCS=1 (see docs/launch-options.md).", { kind: "warn", duration: 6000 });
        return;
      }
      await call("tools:open-url", `${s.base}/docs`);
    }
  });
})();
