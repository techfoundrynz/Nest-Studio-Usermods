/*
 * Loads the loader under a stubbed Electron and exercises the hooks, bundled mods and IPC surface.
 * Run after a workspace build:  node packages/loader/dist/tests/harness.js   (pnpm test does both)
 */
import * as fs from "node:fs";
import Module = require("node:module");
import * as os from "node:os";
import * as path from "node:path";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const opened: string[] = [];
const USER_DATA =
  process.platform === "win32"
    ? String.raw`C:\Users\test\AppData\Roaming\Nest Studio`
    : "/Users/test/Library/Application Support/Nest Studio";
const arcWelder =
  process.platform === "darwin"
    ? "/Applications/Nest Studio.app/Contents/Resources/ArcWelder"
    : String.raw`C:\Program Files\nest-studio\resources\ArcWelder.exe`;
if (fs.existsSync(arcWelder) && !process.env.NEST_ARCWELDER) process.env.NEST_ARCWELDER = arcWelder;
process.env.USERMOD_HARNESS = "1"; // mods that open sockets (lan-monitor) stay quiet under test
const webContentsHooks: ((event: unknown, contents: unknown) => void)[] = [];
const syncHandlers = new Map<string, (event: { returnValue?: unknown }) => void>();
const sendSync = <T>(channel: string): T => {
  const handler = syncHandlers.get(channel);
  if (!handler) throw new Error(`no sync handler for ${channel}`);
  const event: { returnValue?: unknown } = {};
  handler(event);
  return event.returnValue as T;
};
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
    removeHandler: (channel: string) => void handlers.delete(channel),
    /** Synchronous channels (the bed-size preload handshake) answer through event.returnValue. */
    on: (channel: string, fn: (event: { returnValue?: unknown }) => void) => void syncHandlers.set(channel, fn)
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

/* The run gets its own config file (USERMOD_CONFIG) built from mods.default.json. The developer's mods.json is
 * never read or written: the app may be running while the tests are, and a restore-on-exit would undo whatever
 * was changed in the app meanwhile. */
const rootDir = path.resolve(__dirname, "..", "..", "..", "..");
const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usermod-test-")), "mods.json");
process.env.USERMOD_CONFIG = configPath;
fs.copyFileSync(path.join(rootDir, "mods.default.json"), configPath);
process.on("exit", () => fs.rmSync(path.dirname(configPath), { recursive: true, force: true }));

interface MigrationForTest {
  into: string;
  settings(old: Record<string, unknown>, wasEnabled: boolean): Record<string, unknown>;
}
const loader = require(path.join(__dirname, "..", "main.js")) as {
  ROOT_DIR: string;
  CONFIG_FILE: string;
  applyMigrations(config: Usermod.Config, migrations: Record<string, MigrationForTest>): { config: Usermod.Config; changed: string[] };
};
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
  // The rename/merge machinery carries no entries today, so exercise it directly.
  const moved = loader.applyMigrations(
    { enabled: ["old-mod", "arc-fit"], settings: { "old-mod": { feed: 1200 }, "arc-fit": { minBytes: 1 } } },
    { "old-mod": { into: "jog", settings: (o, wasEnabled) => ({ keyboardEnabled: wasEnabled, keyboardFeed: o.feed }) } }
  );
  check(
    "config migration renames a mod, carries its settings over and leaves the rest alone",
    moved.changed.length === 1 &&
      moved.config.enabled.join(",") === "arc-fit,jog" &&
      moved.config.settings["jog"]?.keyboardFeed === 1200 &&
      moved.config.settings["jog"]?.keyboardEnabled === true &&
      moved.config.settings["old-mod"] === undefined &&
      moved.config.settings["arc-fit"]?.minBytes === 1,
    JSON.stringify(moved)
  );
  const enabledSet = initial.available.filter((m) => !m.core).map((m) => m.name);
  const enabledInfo = data(await invoke<Usermod.Info>("usermod:set-enabled", enabledSet));
  check("set-enabled activates post-processors and main mods immediately", enabledInfo.postprocessors.length === 9 && enabledInfo.mainMods.length === 10, `${enabledInfo.postprocessors.length} pps, ${enabledInfo.mainMods.length} main`);
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
  check("feed-scale neutral leaves F/S untouched", out.includes("F800") && out.includes("S12000"));
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
  } else console.log("SKIP arc-fit (ArcWelder not found)");

  // peck-drill: a 15 mm straight plunge followed by a retract becomes 3 mm pecks; the profile plunge in `gcode` stays.
  const drill = ["(header)", "G21 G90", "T1 M6", "S12000 M3", "G0 X5 Y5 Z5", "G1 Z-10 F200", "G0 Z5", "G1 X20 Y15 F800", "M30", ""].join("\n");
  await invoke("store:write-file", `${downloads}drill.nc`, drill);
  const pecked = written!.data;
  check("peck-drill converts the drilling plunge", pecked.includes("(usermod peck-drill: 15 mm plunge") && (pecked.match(/^G1 Z/gm)?.length ?? 0) >= 5 && pecked.includes("G0 Z5") && pecked.includes("G1 X20 Y15 F800"), pecked.split("\n").slice(4, 14).join(" | "));
  check("peck-drill leaves the profile plunge in the first program alone", !out.includes("(usermod peck-drill"));
  // export-report checks: 18 mm stock from the header, a cut to Z-25 and a low rapid are reported, nothing is changed.
  const deep = ['({"machineModel":"C500","stockSize":"600*400*18"})', "G21 G90", "G0 X0 Y0 Z5", "G1 Z-25 F300", "G1 X10 Y10", "G0 X50 Y50", "M30", ""].join("\n");
  await invoke("store:write-file", `${downloads}deep.nc`, deep);
  const guard = JSON.parse(fs.readFileSync(path.join(loader.ROOT_DIR, "data", "reports", "latest.json"), "utf8")) as { stockThickness: number | null; issues: { kind: string; count: number }[] };
  check("export read the stock thickness from the header and flagged below-stock + low rapid", guard.stockThickness === 18 && guard.issues.some((i) => i.kind === "below-stock") && guard.issues.some((i) => i.kind === "low-rapid"), JSON.stringify(guard.issues));
  check("export checks do not modify the program", written!.data.includes("G1 Z-25 F300") && !written!.data.includes("usermod depth"));
  // tool-split: a real temp folder so the per-tool files can be written next to the export.
  const splitDir = fs.mkdtempSync(path.join(os.tmpdir(), "usermod-split-"));
  await invoke("store:write-file", path.join(splitDir, "three.nc"), twoTools);
  const parts = fs.readdirSync(splitDir).sort();
  const partT2 = parts.includes("three-T2.nc") ? fs.readFileSync(path.join(splitDir, "three-T2.nc"), "utf8") : "";
  check("tool-split wrote one file per tool section", JSON.stringify(parts) === JSON.stringify(["three-T1.nc", "three-T2.nc"]), parts.join(","));
  check("tool-split part files carry the preamble, their section and a footer", partT2.startsWith("(header line 1)") && partT2.includes("T2 M6") && partT2.includes("G1 X0 Y0") && partT2.trim().endsWith("M30") && !partT2.includes("G1 X20 Y15"), partT2.split("\n").slice(0, 6).join(" | "));
  const splitLines = written!.data.split("\n");
  const indexAt = splitLines.findIndex((l) => l.startsWith("(usermod tool-split: per-tool files"));
  const firstCode = splitLines.findIndex((l) => l.trim() !== "" && !l.startsWith("("));
  check("tool-split adds an index comment inside the header block", indexAt > 0 && indexAt < firstCode, splitLines.slice(0, 8).join(" | "));
  fs.rmSync(splitDir, { recursive: true, force: true });

  // toolpath-modifiers: the preview stage runs only the chosen processors and marks the G-code; export then skips them.
  await invoke("usermod:set-settings", "toolpath-modifiers", { preview: ["peck-drill"] });
  const previewed = data(await invoke<string>("usermod:run-postprocessors", "preview", drill, { endpoint: "/api/drillPath" }));
  check("preview stage applies the chosen processor and leaves a marker", previewed.startsWith("(usermod-preview-applied: peck-drill)") && previewed.includes("(usermod peck-drill: 15 mm plunge") && !previewed.includes("(--- Nest Studio usermod ---)"), previewed.split("\n").slice(0, 3).join(" | "));
  await invoke("store:write-file", `${downloads}previewed.nc`, previewed);
  check("export skips processors already applied at preview", (written!.data.match(/\(usermod peck-drill: /g)?.length ?? 0) === 1 && written!.data.includes("(--- Nest Studio usermod ---)"), written!.data.split("\n").slice(0, 4).join(" | "));
  const modStatus = data(await invoke<{ intercepting: boolean; reason: string | null }>("usermod:modifiers:status"));
  check("toolpath-modifiers stays passive under the harness", modStatus.intercepting === false && modStatus.reason === "harness run", JSON.stringify(modStatus));
  await invoke("usermod:set-settings", "toolpath-modifiers", { preview: [] });
  await invoke("store:write-file", `${downloads}two.nc`, big); // later checks read the report of the last two-tool export

  written = null;
  await invoke("store:write-file", `${USER_DATA}${sep}gcode-work${sep}checkGcode.nc`, gcode);
  check("internal userData path untouched", written!.data === gcode);
  written = null;
  await invoke("store:write-file", `${downloads}notes.txt`, gcode);
  check("non-gcode file untouched", written!.data === gcode);

  let sent: Record<string, unknown> | null = null;
  fakeElectron.ipcMain.handle("device:send-gcode", (_e, options) => {
    sent = typeof options === "object" && options !== null ? { ...(options as object) } : null;
    return { ok: true };
  });
  await invoke("device:send-gcode", { fileName: "a.nc", gcode, gcodeRunTime: 5 });
  check("send stage passes through (bundled pps are export-only)", sent!.gcode === gcode && sent!.gcodeRunTime === 5);

  const info = data(await invoke<Usermod.Info>("usermod:info"));
  check("enabled postprocessors in manifest order", JSON.stringify(info.postprocessors.map((p) => p.name)) === JSON.stringify(["feed-scale", "arc-fit", "tool-change", "program-header", "safe-shutdown", "peck-drill", "gcode-format", "tool-split", "export"]), info.postprocessors.map((p) => p.name).join(","));
  check("export wrote latest.json", fs.existsSync(path.join(loader.ROOT_DIR, "data", "reports", "latest.json")) && JSON.parse(fs.readFileSync(path.join(loader.ROOT_DIR, "data", "reports", "latest.json"), "utf8")).tools.includes(2));
  check("gcode-format is a no-op until one of its features is switched on", !out.includes("N10 ") && out.includes("(File: part.nc)"));
  check("available lists every package with enabled state", info.available.length >= 13 && info.available.find((m) => m.name === "mods-menu")?.core === true && info.available.find((m) => m.name === "arc-fit")?.enabled === true);
  const reloadOf = (name: string): string | undefined => info.available.find((m) => m.name === name)?.reload;
  check("reload level derived from kinds", reloadOf("program-header") === "none" && reloadOf("view") === "ui" && reloadOf("jobs") === "app" && reloadOf("app-tools") === "app" && info.available.every((m) => m.reloadDeclared === false));
  check("main mods active", JSON.stringify(info.mainMods.map((m) => m.name).sort()) === JSON.stringify(["app-tools", "appearance", "export", "final-geometry", "jobs", "lan-monitor", "machine-state", "project-backup", "timelapse", "toolpath-modifiers"]), info.mainMods.map((m) => m.name).join(","));
  check("ui mods listed", JSON.stringify(info.uiMods.map((m) => m.name).sort()) === JSON.stringify(["app-tools", "appearance", "bed-size", "cutter", "cycles", "device-macros", "export", "feeds-speeds", "final-geometry", "gcode-lab", "jobs", "jog", "lan-monitor", "mods-menu", "overrides", "tool-change", "toolpath-modifiers", "tools", "view", "work-zero"]), info.uiMods.map((m) => m.name).join(","));

  // Interceptors: export-filename rewrites the save dialog's defaultPath; project-backup copies saved zips.
  let dialogArgs: unknown[] = [];
  fakeElectron.ipcMain.handle("dialog:show-save", (_e, ...args) => {
    dialogArgs = args;
    return { ok: true, data: { filePath: "C:\\x\\y.nc" } };
  });
  await invoke("dialog:show-save", { defaultPath: "Bitcoin.nc", filters: [{ name: "NC Files", extensions: ["nc"] }] });
  const rewritten = (dialogArgs[0] as { defaultPath?: string } | undefined)?.defaultPath ?? "";
  check("export-filename intercepts dialog:show-save (template {name} keeps the name)", rewritten === "Bitcoin.nc", rewritten);
  await invoke("dialog:show-save", { defaultPath: "proj.zip", filters: [{ name: "zip", extensions: ["zip"] }] });
  check("export-filename leaves non-gcode dialogs alone", (dialogArgs[0] as { defaultPath?: string }).defaultPath === "proj.zip");
  const zipPath = path.join(loader.ROOT_DIR, "data", "harness-project.zip");
  fs.writeFileSync(zipPath, "PK-fake");
  fakeElectron.ipcMain.handle("store:write-binary-file", (_e, _p, _b) => ({ ok: true }));
  await invoke("store:write-binary-file", zipPath, Buffer.from("PK-fake"));
  await new Promise((r) => setTimeout(r, 50));
  const backupDir = path.join(loader.ROOT_DIR, "data", "backups", "harness-project");
  check("project-backup copied the saved zip", fs.existsSync(backupDir) && fs.readdirSync(backupDir).some((f) => f.endsWith(".zip")));
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(backupDir, { recursive: true, force: true });
  const ms = data(await invoke<{ phase: string; job: { toolChanges: { line: number }[] } }>("usermod:machine:state"));
  check("machine-state saw the sent job and its tool change lines", ms.phase === "running" && ms.job.toolChanges.length >= 1, JSON.stringify(ms.job.toolChanges));
  const zoom = data(await invoke<{ zoom: number }>("usermod:appearance:set-zoom", 1.25));
  check("appearance clamps and reports zoom", zoom.zoom === 1.25 && data(await invoke<{ zoom: number }>("usermod:appearance:set-zoom", 9)).zoom === 2);

  // jobs: gcode-sent event recorded the job; machine status arrives through the machine-state in-process event.
  const status1 = data(await invoke<{ fileName: string | null; totalLines: number | null; phase: string }>("usermod:jobs:status"));
  check("jobs saw gcode-sent", status1.fileName === "a.nc" && status1.totalLines === 10 && status1.phase === "running", JSON.stringify(status1));
  check("main mods hooked web-contents-created (appearance, machine-state, timelapse, lan-monitor)", webContentsHooks.length === 4, String(webContentsHooks.length));
  const fakeContents = { send: (_channel: string, ..._args: unknown[]) => undefined, on: (_event: string, _listener: unknown) => undefined, getURL: () => "file:///renderer/index.html" };
  for (const hook of webContentsHooks) hook({}, fakeContents);
  fakeContents.send("device:stream-event", { type: "machine_status", payload: { status: "Hold", Ln: 42, MPos: "-10.5,-20,-3.25", WPos: "0,0,-1", FS: "500,12000", G: 55, T: "2" } });
  fakeContents.send("device:stream-event", { type: "console_line", line: "error:9 G-code locked out during alarm or jog state" });
  const status2 = data(await invoke<{ phase: string; lastLine: number | null }>("usermod:jobs:status"));
  check("jobs follows machine status through the machine-state event", status2.phase === "paused" && status2.lastLine === 42, JSON.stringify(status2));
  const ms2 = data(await invoke<Usermod.MachineState>("usermod:machine:state"));
  check("machine-state parses MPos/WPos/FS/G/T and keeps the last error line", ms2.mpos?.x === -10.5 && ms2.mpos?.z === -3.25 && ms2.wpos?.z === -1 && ms2.feed === 500 && ms2.spindle === 12000 && ms2.wcs === 55 && ms2.tool === "2" && ms2.lastError?.line.startsWith("error:9") === true, JSON.stringify({ mpos: ms2.mpos, feed: ms2.feed, wcs: ms2.wcs, err: ms2.lastError }));
  const jobs = data(await invoke<{ fileName: string; outcome: string; tools: string[] }[]>("usermod:jobs:list"));
  check("jobs history recorded the sent program", jobs[0]?.fileName === "a.nc" && jobs[0].outcome === "running" && jobs[0].tools.includes("T1"), JSON.stringify(jobs[0]));
  const monitor = data(await invoke<{ listening: boolean; urls: string[]; port: number }>("usermod:monitor:status"));
  check("lan-monitor stays quiet under the harness but reports its addresses", monitor.listening === false && monitor.port === 9640 && monitor.urls.length > 0, JSON.stringify(monitor));
  check("mods-menu first ui mod (order 10)", info.uiMods[0]?.name === "mods-menu");
  check("builtin runtime entries hidden from info", !info.uiMods.some((m) => m.builtin));
  const ui = data(await invoke<Usermod.UiModEntry[]>("usermod:list-ui-mods"));
  check("ui-runtime first with file URL", ui[0]?.name === "ui-runtime" && ui[0].url.startsWith("file:///") && ui[0].url.endsWith("/loader/dist/ui-runtime.js"), ui[0]?.url);
  check("ui-kit injected second", ui[1]?.name === "ui-kit" && ui[1].builtin === true && fs.existsSync(ui[1].file), ui[1]?.url);
  check("ui-kit bundle carries React (single builtin after the runtime)", fs.statSync(ui[1]!.file).size > 100000 && ui[2]?.builtin === undefined && ui[2]?.name === "mods-menu", ui[2]?.name);
  check("ui mod urls point at built dist files", ui.filter((m) => !m.builtin).every((m) => m.url.includes("/mods/") && m.url.endsWith(".js") && fs.existsSync(m.file)));

  const saved = data(await invoke<Usermod.Config>("usermod:set-settings", "appearance", { followSystem: true }));
  check("set-settings updates config", saved.settings["appearance"]?.followSystem === true && fs.readFileSync(configPath, "utf8").includes('"followSystem": true'));
  const badName = await invoke("usermod:set-settings", "../evil", {});
  check("set-settings rejects bad names", !badName.ok);

  // bed-size: the preload handshake reports travel in the shape the app's own constant uses.
  const bedDefault = sendSync<Usermod.BedOverride>("usermod:bed-sync");
  check("bed override falls back to the app's own envelope until it is configured", bedDefault.limits.X.min === -238 && bedDefault.limits.Y.min === -200 && bedDefault.limits.Z.min === -123 && bedDefault.platform === 225, JSON.stringify(bedDefault.limits));
  await invoke("usermod:set-settings", "bed-size", { enabled: true, travelX: 400, travelY: 300, travelZ: 150, platform: 420 });
  const bedOn = sendSync<Usermod.BedOverride>("usermod:bed-sync");
  check("bed override reports the configured travel as negative machine coordinates", bedOn.enabled === true && bedOn.limits.X.min === -400 && bedOn.limits.Y.min === -300 && bedOn.limits.Z.min === -150 && bedOn.limits.Z.max === 0 && bedOn.platform === 420, JSON.stringify(bedOn));
  await invoke("usermod:set-settings", "bed-size", { enabled: false });
  check("bed override honours its own enabled flag", sendSync<Usermod.BedOverride>("usermod:bed-sync").enabled === false);

  check("read-file inside repo", data(await invoke<string>("usermod:read-file", "mods.default.json")).includes("settings"));
  check("the developer's mods.json is untouched by the tests", loader.CONFIG_FILE === configPath && !configPath.startsWith(rootDir), loader.CONFIG_FILE);
  const errorsBefore = data(await invoke<Usermod.Info>("usermod:info")).errors.length;
  const missing = await invoke<string>("usermod:read-file", "data/reports/does-not-exist.json");
  check("read-file of a missing file is ok:false without a recorded error", !missing.ok && /not found/.test(missing.message) && data(await invoke<Usermod.Info>("usermod:info")).errors.length === errorsBefore);
  check("exists reports presence", data(await invoke<boolean>("usermod:exists", "mods.json")) === true && data(await invoke<boolean>("usermod:exists", "nope.json")) === false);
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
  check("reload ok", rl.postprocessors.length === 9);
  fs.rmSync(path.join(loader.ROOT_DIR, "data", "reports"), { recursive: true, force: true });

  const noise = data(await invoke<Usermod.Info>("usermod:info")).errors.filter((e) => !/^ipc:(read-file|write-file|set-settings|set-enabled)$|^mod-ipc:app-tools:tools:open-url/.test(e.scope));
  check("no unexpected loader errors", noise.length === 0, JSON.stringify(noise));
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
