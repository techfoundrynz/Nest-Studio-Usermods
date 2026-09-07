/*
 * Loads the loader under a stubbed Electron and exercises the hooks, bundled mods and IPC surface.
 * Run after a workspace build:  node packages/loader/dist/tests/harness.js   (pnpm test does both)
 */
import * as fs from "node:fs";
import Module = require("node:module");
import * as path from "node:path";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const opened: string[] = [];
const USER_DATA = String.raw`C:\Users\test\AppData\Roaming\Nest Studio`;
const fakeElectron = {
  app: {
    getVersion: () => "1.1.0-test",
    getPath: (name: string) => (name === "userData" ? USER_DATA : path.dirname(USER_DATA)),
    whenReady: () => Promise.resolve()
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => void handlers.set(channel, fn),
    removeHandler: (channel: string) => void handlers.delete(channel)
  },
  shell: {
    openPath: async (p: string) => {
      opened.push(p);
      return "";
    },
    openExternal: async (u: string) => {
      opened.push(u);
    }
  },
  BrowserWindow: { getAllWindows: () => [] as unknown[] }
};
type LoadFn = (request: string, ...rest: unknown[]) => unknown;
const moduleInternals = Module as unknown as { _load: LoadFn };
const originalLoad = moduleInternals._load;
moduleInternals._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === "electron" ? fakeElectron : originalLoad.call(this, request, ...rest);
};

const loader = require(path.join(__dirname, "..", "main.js")) as { ROOT_DIR: string };
const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<Usermod.IpcResult<T>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(handler({}, ...args) as Usermod.IpcResult<T>);
};
const data = <T>(r: Usermod.IpcResult<T>): T => {
  if (!r.ok) throw new Error(r.message);
  return r.data;
};

void (async () => {
  let failures = 0;
  const check = (name: string, cond: boolean, extra = ""): void => {
    console.log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`);
    if (!cond) failures++;
  };
  const sep = path.sep;
  const downloads = `${path.dirname(USER_DATA)}${sep}Downloads${sep}`;

  let written: { filePath: string; data: string } | null = null;
  fakeElectron.ipcMain.handle("store:write-file", (_e, filePath, d) => {
    written = { filePath: String(filePath), data: String(d) };
    return { ok: true };
  });
  const gcode = '(header line 1)\n({"machineModel":"C500"})\nG21 G90 G17\nT1 M6\nS12000 M3\nM8\nG0 X10 Y-5 Z5 F800\nG1 Z-2 F300\nG1 X20 Y15\nM30\n';

  await invoke("store:write-file", `${downloads}part.nc`, gcode);
  const out = written!.data;
  const lines = out.split("\n");
  check("app header lines preserved first", lines[0] === "(header line 1)" && (lines[1] ?? "").startsWith("({"));
  check("program-header inserted after app header", (lines[2] ?? "").startsWith("(--- Nest Studio usermod ---)") && out.includes("(File: part.nc)"));
  check("program-header stats: tools/feed/bounds", out.includes("(Tools: T1)") && out.includes("Feed: 300 to 800") && out.includes("X 10.000..20.000"));
  check("safe-shutdown inserted M5 and M9 before M30", /M5 \(usermod[^\n]*\nM9 \(usermod[^\n]*\nM30/.test(out));
  check("feed-override neutral leaves F/S untouched", out.includes("F800") && out.includes("S12000"));
  check("body code preserved", out.includes("G1 X20 Y15") && out.trim().endsWith("M30"));

  written = null;
  await invoke("store:write-file", `${USER_DATA}${sep}gcode-work${sep}checkGcode.nc`, gcode);
  check("internal userData path untouched", written!.data === gcode);
  written = null;
  await invoke("store:write-file", `${downloads}notes.txt`, gcode);
  check("non-gcode file untouched", written!.data === gcode);

  let sent: Record<string, unknown> | null = null;
  fakeElectron.ipcMain.handle("device:send-gcode", (_e, options) => {
    sent = options as Record<string, unknown>;
    return { ok: true };
  });
  await invoke("device:send-gcode", { fileName: "a.nc", gcode, gcodeRunTime: 5 });
  check("send stage passes through (bundled pps are export-only)", sent!.gcode === gcode && sent!.gcodeRunTime === 5);

  const info = data(await invoke<Usermod.Info>("usermod:info"));
  check("enabled postprocessors in manifest order", JSON.stringify(info.postprocessors.map((p) => p.name)) === JSON.stringify(["feed-override", "program-header", "safe-shutdown", "export-copy"]), info.postprocessors.map((p) => p.name).join(","));
  check("disabled mods (mods.json) not loaded", !info.postprocessors.some((p) => ["strip-comments", "line-numbers"].includes(p.name)));
  check("main mod app-tools active", info.mainMods.some((m) => m.name === "app-tools"));
  check("ui mods listed", JSON.stringify(info.uiMods.map((m) => m.name).sort()) === JSON.stringify(["app-tools", "dark-mode", "dev-shortcuts", "gcode-lab", "mods-menu"]), info.uiMods.map((m) => m.name).join(","));
  check("mods-menu first ui mod (order 10)", info.uiMods[0]?.name === "mods-menu");
  check("builtin runtime entries hidden from info", !info.uiMods.some((m) => m.builtin));
  const ui = data(await invoke<Usermod.UiModEntry[]>("usermod:list-ui-mods"));
  check("ui-runtime first with file URL", ui[0]?.name === "ui-runtime" && ui[0].url.startsWith("file:///") && ui[0].url.endsWith("/loader/dist/ui-runtime.js"), ui[0]?.url);
  check("ui-kit injected second", ui[1]?.name === "ui-kit" && ui[1].builtin === true && fs.existsSync(ui[1].file), ui[1]?.url);
  check("ui mod urls point at built dist files", ui.slice(2).every((m) => m.url.includes("/mods/") && m.url.endsWith(".js") && fs.existsSync(m.file)));

  const before = fs.readFileSync(path.join(loader.ROOT_DIR, "mods.json"), "utf8");
  const saved = data(await invoke<Usermod.Config>("usermod:set-settings", "dark-mode", { followSystem: true }));
  check("set-settings updates config", saved.settings["dark-mode"]?.followSystem === true && fs.readFileSync(path.join(loader.ROOT_DIR, "mods.json"), "utf8").includes('"followSystem": true'));
  const badName = await invoke("usermod:set-settings", "../evil", {});
  check("set-settings rejects bad names", !badName.ok);
  fs.writeFileSync(path.join(loader.ROOT_DIR, "mods.json"), before, "utf8");
  await invoke("usermod:reload");

  check("read-file inside repo", data(await invoke<string>("usermod:read-file", "mods.json")).includes("settings"));
  const esc = await invoke("usermod:read-file", `..${sep}store.json`);
  check("read-file traversal rejected", !esc.ok && /escapes/.test(esc.message));
  const wf = await invoke<string>("usermod:write-file", `test${sep}hello.txt`, "hi");
  check("write-file confined to data dir", wf.ok && wf.data.endsWith(`${sep}data${sep}test${sep}hello.txt`));
  const wf2 = await invoke("usermod:write-file", `..${sep}..${sep}mods.json`, "x");
  check("write-file escaping data dir rejected", !wf2.ok);
  fs.rmSync(path.join(loader.ROOT_DIR, "data", "test"), { recursive: true, force: true });

  const ping = data(await invoke<{ pong: unknown; appVersion: string }>("usermod:tools:ping", "yo"));
  check("app-tools ping", ping.pong === "yo" && ping.appVersion === "1.1.0-test");
  const bad = await invoke("usermod:tools:open-url", "https://example.com");
  check("open-url rejects non-loopback", !bad.ok && /loopback/.test(bad.message));
  const good = await invoke("usermod:tools:open-url", "http://127.0.0.1:9630/docs");
  check("open-url accepts loopback", good.ok && opened.includes("http://127.0.0.1:9630/docs"));

  const rp = data(await invoke<string>("usermod:run-postprocessors", "export", gcode, { fileName: "x.nc" }));
  check("run-postprocessors manual", rp.includes("(File: x.nc)"));
  const rl = data(await invoke<Usermod.Info>("usermod:reload"));
  check("reload ok", rl.postprocessors.length === 4);

  const noise = data(await invoke<Usermod.Info>("usermod:info")).errors.filter((e) => !/^ipc:(read-file|write-file|set-settings)$|^mod-ipc:app-tools:tools:open-url/.test(e.scope));
  check("no unexpected loader errors", noise.length === 0, JSON.stringify(noise));
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
