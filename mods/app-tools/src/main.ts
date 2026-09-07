/*
 * App tools (main process): privileged helpers exposed to UI mods over usermod.invoke("tools:*").
 * Uses Electron's shell directly, so it is not bound by the app's external-URL allowlist; only
 * loopback URLs are accepted here on purpose.
 */
import * as path from "node:path";

const CAM_BASE = "http://127.0.0.1:9630";

interface CamStatus {
  base: string;
  reachable: boolean;
  version: string | null;
  time: string | null;
  docs: boolean;
}

const mod: Usermod.MainMod = {
  description: "Open log folders, CAM service status, loopback URL opener",
  activate(api) {
    const { shell } = api.electron;

    api.handle("tools:ping", (message: unknown) => ({ pong: message ?? null, time: new Date().toISOString(), appVersion: api.app.getVersion() }));
    api.handle("tools:open-logs", () => shell.openPath(path.join(api.app.getPath("userData"), "logs")));
    api.handle("tools:open-userdata", () => shell.openPath(api.app.getPath("userData")));
    api.handle("tools:open-usermod-log", () => shell.openPath(path.join(api.modDir, "usermod.log")));
    api.handle("tools:open-url", (url: unknown) => {
      const parsed = new URL(String(url));
      if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) throw new Error("only loopback URLs are allowed");
      return shell.openExternal(parsed.href);
    });
    api.handle("tools:cam-status", async (): Promise<CamStatus> => {
      const status: CamStatus = { base: CAM_BASE, reachable: false, version: null, time: null, docs: false };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(`${CAM_BASE}/api/version`, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) {
          const body = (await response.json()) as { version?: string; time?: string };
          status.reachable = true;
          status.version = body.version ?? null;
          status.time = body.time ?? null;
          const docs = await fetch(`${CAM_BASE}/swagger.json`).catch(() => null);
          status.docs = Boolean(docs && docs.ok);
        }
      } catch {
        /* unreachable */
      }
      return status;
    });
    api.handle("tools:tool-library", () => api.readStore().toolLibary?.cutLibrarySettings ?? []);
    api.log("app-tools active");
  }
};

export = mod;
