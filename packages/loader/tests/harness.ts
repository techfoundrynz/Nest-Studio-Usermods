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
const arcWelder = String.raw`C:\Program Files\nest-studio\resources\ArcWelder.exe`;
if (fs.existsSync(arcWelder) && !process.env.NEST_ARCWELDER) process.env.NEST_ARCWELDER = arcWelder;
const webContentsHooks: ((event: unknown, contents: unknown) => void)[] = [];
const fakeElectron = {
  app: {
    getVersion: () => "1.1.0-test",
    getPath: (name: string) => (name === "userData" ? USER_DATA : path.dirname(USER_DATA)),
    whenReady: () => Promise.resolve(),
    on: (event: string, listener: (event: unknown, contents: unknown) => void) => {
      if (event === "web-contents-created") webContentsHooks.push(listener);
    }
  },
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    show(): void { }
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

// Test against a fresh copy of mods.default.json, never the developer's own mods.json; restore on exit.
const rootDir = path.resolve(__dirname, "..", "..", "..", "..");
const configPath = path.join(rootDir, "mods.json");
const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
fs.copyFileSync(path.join(rootDir, "mods.default.json"), configPath);
process.on("exit", () => {
  if (originalConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, originalConfig, "utf8");
});

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

  // mods.default.json ships with nothing enabled; enable the bundled set for the rest of the run.
  check("loader root matches the repo root", path.resolve(loader.ROOT_DIR) === rootDir, loader.ROOT_DIR);
  const initial = data(await invoke<Usermod.Info>("usermod:info"));
  check("nothing enabled by default except core", initial.available.filter((m) => m.enabled).every((m) => m.core) && initial.available.some((m) => m.core && m.name === "mods-menu"));
  const enabledSet = initial.available.filter((m) => !m.core && !["strip-comments", "line-numbers"].includes(m.name)).map((m) => m.name);
  const enabledInfo = data(await invoke<Usermod.Info>("usermod:set-enabled", enabledSet));
  check("set-enabled activates post-processors and main mods immediately", enabledInfo.postprocessors.length === 6 && enabledInfo.mainMods.length === 3, `${enabledInfo.postprocessors.length} pps, ${enabledInfo.mainMods.length} main`);
  check("set-enabled rejects unknown names", !(await invoke("usermod:set-enabled", ["../x"])).ok);

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
  check("tool-change-guard skips the first change by default", !out.includes("(usermod: tool change"));

  // Second tool change mid-program with spindle and coolant running: guard must insert M5, M9 and a retract.
  const twoTools = gcode.replace("G1 X20 Y15\n", "G1 X20 Y15\nT2 M6\nS9000 M3\nG1 X0 Y0\n");
  // Padding before M30 pushes the program over arc-fit's minBytes so ArcWelder actually runs when available.
  const big = twoTools.replace("M30\n", `${"(pad)\n".repeat(400)}M30\n`);
  await invoke("store:write-file", `${downloads}two.nc`, big);
  const out2 = written!.data;
  check("tool-change-guard guards the second change", /\(usermod: tool change T2\)\nM5\nM9\nG53 G90 G0 Z-1\nT2 M6/.test(out2), out2.split("\n").slice(9, 16).join(" | "));
  if (process.env.NEST_ARCWELDER) {
    check("arc-fit ran through ArcWelder and kept the program", /G1 X20(\.0+)? Y15(\.0+)?/.test(out2) && out2.includes("(File: two.nc)") && out2.trim().endsWith("M30"), out2.split("\n").slice(-3).join(" | "));
  } else console.log("SKIP arc-fit (ArcWelder.exe not found)");

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
  check("enabled postprocessors in manifest order", JSON.stringify(info.postprocessors.map((p) => p.name)) === JSON.stringify(["feed-override", "arc-fit", "tool-change-guard", "program-header", "safe-shutdown", "export-copy"]), info.postprocessors.map((p) => p.name).join(","));
  check("mods left out of enabled are not loaded", !info.postprocessors.some((p) => ["strip-comments", "line-numbers"].includes(p.name)));
  check("available lists every package with enabled state", info.available.length >= 13 && info.available.find((m) => m.name === "strip-comments")?.enabled === false && info.available.find((m) => m.name === "arc-fit")?.enabled === true);
  const reloadOf = (name: string): string | undefined => info.available.find((m) => m.name === name)?.reload;
  check("reload level derived from kinds", reloadOf("program-header") === "none" && reloadOf("dark-mode") === "ui" && reloadOf("job-notifier") === "app" && reloadOf("app-tools") === "app" && info.available.every((m) => m.reloadDeclared === false));
  check("main mods active", JSON.stringify(info.mainMods.map((m) => m.name).sort()) === JSON.stringify(["app-tools", "job-notifier", "ui-scale"]), info.mainMods.map((m) => m.name).join(","));
  check("ui mods listed", JSON.stringify(info.uiMods.map((m) => m.name).sort()) === JSON.stringify(["app-tools", "dark-mode", "dev-shortcuts", "gcode-lab", "job-notifier", "mods-menu", "ui-scale"]), info.uiMods.map((m) => m.name).join(","));
  const zoom = data(await invoke<{ zoom: number }>("usermod:ui-scale:set-zoom", 1.25));
  check("ui-scale clamps and reports zoom", zoom.zoom === 1.25 && data(await invoke<{ zoom: number }>("usermod:ui-scale:set-zoom", 9)).zoom === 2);

  // job-notifier: gcode-sent event recorded the job; a machine_status stream via webContents.send is observed.
  const status1 = data(await invoke<{ fileName: string | null; totalLines: number | null; phase: string }>("usermod:notifier:status"));
  check("job-notifier saw gcode-sent", status1.fileName === "a.nc" && status1.totalLines === 10 && status1.phase === "running", JSON.stringify(status1));
  check("main mods hooked web-contents-created (job-notifier, ui-scale)", webContentsHooks.length === 2, String(webContentsHooks.length));
  const fakeContents = { send: (_channel: string, ..._args: unknown[]) => undefined, on: (_event: string, _listener: unknown) => undefined, getURL: () => "file:///renderer/index.html" };
  for (const hook of webContentsHooks) hook({}, fakeContents);
  fakeContents.send("device:stream-event", { type: "machine_status", payload: { status: "Hold", Ln: 42 } });
  const status2 = data(await invoke<{ phase: string; lastLine: number | null }>("usermod:notifier:status"));
  check("job-notifier tracks machine status", status2.phase === "paused" && status2.lastLine === 42, JSON.stringify(status2));
  check("mods-menu first ui mod (order 10)", info.uiMods[0]?.name === "mods-menu");
  check("builtin runtime entries hidden from info", !info.uiMods.some((m) => m.builtin));
  const ui = data(await invoke<Usermod.UiModEntry[]>("usermod:list-ui-mods"));
  check("ui-runtime first with file URL", ui[0]?.name === "ui-runtime" && ui[0].url.startsWith("file:///") && ui[0].url.endsWith("/loader/dist/ui-runtime.js"), ui[0]?.url);
  check("ui-kit injected second", ui[1]?.name === "ui-kit" && ui[1].builtin === true && fs.existsSync(ui[1].file), ui[1]?.url);
  check("ui mod urls point at built dist files", ui.slice(2).every((m) => m.url.includes("/mods/") && m.url.endsWith(".js") && fs.existsSync(m.file)));

  const saved = data(await invoke<Usermod.Config>("usermod:set-settings", "dark-mode", { followSystem: true }));
  check("set-settings updates config", saved.settings["dark-mode"]?.followSystem === true && fs.readFileSync(configPath, "utf8").includes('"followSystem": true'));
  const badName = await invoke("usermod:set-settings", "../evil", {});
  check("set-settings rejects bad names", !badName.ok);

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
  const dt = data(await invoke<{ enabled: boolean; reason?: string }>("usermod:tools:toggle-devtools"));
  check("toggle-devtools reports unavailable without a window", dt.enabled === false && dt.reason === "no window");
  const bad = await invoke("usermod:tools:open-url", "https://example.com");
  check("open-url rejects non-loopback", !bad.ok && /loopback/.test(bad.message));
  const good = await invoke("usermod:tools:open-url", "http://127.0.0.1:9630/docs");
  check("open-url accepts loopback", good.ok && opened.includes("http://127.0.0.1:9630/docs"));

  const rp = data(await invoke<string>("usermod:run-postprocessors", "export", gcode, { fileName: "x.nc" }));
  check("run-postprocessors manual", rp.includes("(File: x.nc)"));
  const rl = data(await invoke<Usermod.Info>("usermod:reload"));
  check("reload ok", rl.postprocessors.length === 6);

  const noise = data(await invoke<Usermod.Info>("usermod:info")).errors.filter((e) => !/^ipc:(read-file|write-file|set-settings|set-enabled)$|^mod-ipc:app-tools:tools:open-url/.test(e.scope));
  check("no unexpected loader errors", noise.length === 0, JSON.stringify(noise));
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
