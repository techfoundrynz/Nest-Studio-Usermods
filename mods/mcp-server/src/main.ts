import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createHttpServer, type Dispatch } from "./server";
import { readModelFile } from "./model-file";

const mod: Usermod.MainMod<{ port: number }> = {
  description: "Authenticated localhost MCP server for Nest Studio",
  activate(api) {
    if (process.env.USERMOD_HARNESS) { api.log("harness: not listening"); return; }
    const port = api.settings.port ?? 9641;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("MCP port must be 1024–65535");
    const dir = path.join(api.dataDir, "mcp-server");
    fs.mkdirSync(dir, { recursive: true });
    const tokenFile = path.join(dir, "access-token");
    if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid MCP access-token file; remove it while Nest Studio is closed to generate a new token");
    let listening = false;
    let lastError: string | null = null;
    let mutationBusy = false;
    const readOnly = new Set(["get_status", "get_machining_capabilities", "list_projects", "get_project", "get_cam_state", "get_operation_editor", "get_operation_geometry", "list_tools", "list_jobs", "validate_gcode", "estimate_gcode_time"]);
    const renderer = async (action: string, args: Record<string, unknown>): Promise<unknown> => {
      const win = api.getMainWindow();
      if (!win || win.isDestroyed() || win.webContents.isLoading()) throw new Error("Nest Studio UI is not ready");
      // Only a fixed dispatcher is invoked. Arguments are JSON data, never executable code.
      const script = `(async () => { const run = globalThis.__usermodMcpDispatch; if (!run) throw new Error('MCP UI bridge unavailable; enable mcp-server and reload the UI. Project actions also require the updated loader archive.'); return run(${JSON.stringify(action)}, ${JSON.stringify(args)}); })()`;
      return win.webContents.executeJavaScript(script);
    };
    const dispatch: Dispatch = async (action, args) => {
      const mutating = !readOnly.has(action);
      if (mutating && mutationBusy) throw new Error("Another MCP action is pending. Finish it in Nest Studio before retrying.");
      if (mutating) mutationBusy = true;
      try {
        if (action === "save_project_copy") {
          const target = String(args.filePath);
          if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== ".zip") throw new Error("Provide an absolute .zip output path");
          const result = await renderer(action, { projectId: args.projectId, filePath: target }) as { base64: string };
          const bytes = Buffer.from(result.base64, "base64");
          if (!bytes.length || bytes.length > 64 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid native project archive");
          await fs.promises.writeFile(target, bytes, { flag: "wx" });
          return { filePath: target, bytes: bytes.length, status: "saved_copy" };
        }
        if (action === "open_file") {
          const model = await readModelFile(String(args.filePath));
          const result = await renderer(action, { ...model, axis: args.axis, newProject: args.newProject });
          api.log("MCP open_file: imported");
          return result;
        }
        if (action === "list_jobs") {
          try { return await api.call("jobs:list"); }
          catch { return { available: false, reason: "Enable the jobs mod to read job history" }; }
        }
        if (action === "get_status") {
          let normalized: unknown = null;
          try { normalized = await api.call("machine:state"); } catch { /* optional dependency */ }
          return { appVersion: api.app.getVersion(), machine: await renderer(action, args), normalized };
        }
        if (action === "send_machine_command") {
          const connection = await renderer("get_status", {}) as NestStudio.DeviceStatus;
          if (!connection.connected) throw new Error("No machine connected");
          const win = api.getMainWindow();
          if (!win || win.isDestroyed()) throw new Error("Nest Studio window is unavailable");
          const started = Date.now();
          const result = await api.electron.dialog.showMessageBox(win, {
            type: "warning", title: "MCP machine command", message: "Allow this command on the connected CNC machine?",
            detail: `${connection.address ?? "Connected machine"}\n\n${String(args.command)}`, buttons: ["Cancel", "Send command"], defaultId: 0, cancelId: 0, noLink: true
          });
          if (result.response !== 1) throw new Error("Command cancelled in Nest Studio");
          if (Date.now() - started > 60000) throw new Error("Command approval expired; no command was sent");
          args = { ...args, expectedConnection: { address: connection.address ?? null, connectionType: connection.connectionType ?? null } };
        }
        const result = await renderer(action, args);
        if (mutating) api.log(`MCP ${action}: completed/requested`); // Never log arguments or pairing codes.
        return result;
      } finally { if (mutating) mutationBusy = false; }
    };
    const server = createHttpServer(token, dispatch);
    server.on("error", (error: NodeJS.ErrnoException) => {
      lastError = error.code === "EADDRINUSE" ? `Port ${port} is already in use` : error.message;
      listening = false;
      api.warn(`MCP server: ${lastError}`);
    });
    server.listen(port, "127.0.0.1", () => { listening = true; api.log(`MCP listening at http://127.0.0.1:${port}/mcp`); });
    server.unref();
    api.app.once("before-quit", () => { server.close(); server.closeAllConnections(); });
    api.handle("mcp:status", () => ({ listening, url: `http://127.0.0.1:${port}/mcp`, error: lastError, mutationBusy }));
    api.handle("mcp:client-config", () => ({ mcpServers: { "nest-studio": { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }));
  }
};
export = mod;
