"use strict";
/*
 * Loads loader/main.js under a stubbed Electron and exercises the hooks and IPC surface.
 * Run: node tests/harness.js   (or tools via tests/run-tests.ps1)
 */
const path = require("path");
const Module = require("module");

const handlers = new Map();
const USER_DATA = process.platform === "win32" ? String.raw`C:\Users\test\AppData\Roaming\Nest Studio` : "/home/test/.config/Nest Studio";
const opened = [];
const fakeElectron = {
  app: {
    getVersion: () => "1.1.0-test",
    getPath: (name) => (name === "userData" ? USER_DATA : path.dirname(USER_DATA)),
    whenReady: () => Promise.resolve()
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel)
  },
  shell: { openPath: async (p) => (opened.push(p), ""), openExternal: async (u) => (opened.push(u), undefined) },
  BrowserWindow: { getAllWindows: () => [] }
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "electron" ? fakeElectron : origLoad.call(this, request, ...rest);
};

const loaderPath = path.join(__dirname, "..", "loader", "main.js");
const loader = require(loaderPath);
const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);

(async () => {
  let failures = 0;
  const check = (name, cond, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`);
    if (!cond) failures++;
  };
  const sep = path.sep;
  const downloads = `${path.dirname(USER_DATA)}${sep}Downloads${sep}`;

  let written = null;
  fakeElectron.ipcMain.handle("store:write-file", (_e, filePath, data) => ((written = { filePath, data }), { ok: true }));
  const gcode = '(header line 1)\n({"machineModel":"C500"})\nG21 G90 G17\nT1 M6\nS12000 M3\nM8\nG0 X10 Y-5 Z5 F800\nG1 Z-2 F300\nG1 X20 Y15\nM30\n';

  await invoke("store:write-file", `${downloads}part.nc`, gcode);
  const out = written.data;
  const lines = out.split("\n");
  check("app header lines preserved first", lines[0] === "(header line 1)" && lines[1].startsWith("({"));
  check("program-header inserted after app header", lines[2].startsWith("(--- Nest Studio usermod ---)") && out.includes("(File: part.nc)"));
  check("program-header stats: tools/feed/bounds", out.includes("(Tools: T1)") && out.includes("Feed: 300 to 800") && out.includes("X 10.000..20.000"));
  check("safe-shutdown inserted M5 and M9 before M30", /M5 \(usermod[^\n]*\nM9 \(usermod[^\n]*\nM30/.test(out));
  check("feed-override neutral leaves F/S untouched", out.includes("F800") && out.includes("S12000"));
  check("body code preserved", out.includes("G1 X20 Y15") && out.trim().endsWith("M30"));

  written = null;
  await invoke("store:write-file", `${USER_DATA}${sep}gcode-work${sep}checkGcode.nc`, gcode);
  check("internal userData path untouched", written.data === gcode);
  written = null;
  await invoke("store:write-file", `${downloads}notes.txt`, gcode);
  check("non-gcode file untouched", written.data === gcode);

  let sent = null;
  fakeElectron.ipcMain.handle("device:send-gcode", (_e, options) => ((sent = options), { ok: true }));
  await invoke("device:send-gcode", { fileName: "a.nc", gcode, gcodeRunTime: 5 });
  check("send stage passes through (all bundled pps are export-only)", sent.gcode === gcode && sent.gcodeRunTime === 5);

  const info = (await invoke("usermod:info")).data;
  check("4 enabled postprocessors in file order", JSON.stringify(info.postprocessors.map((p) => p.name)) === JSON.stringify(["feed-override", "program-header", "safe-shutdown", "export-copy"]), info.postprocessors.map((p) => p.name).join(","));
  check("underscore-prefixed pps disabled", !info.postprocessors.some((p) => ["strip-comments", "line-numbers"].includes(p.name)));
  check("main mod app-tools active", info.mainMods.some((m) => m.name === "app-tools"));
  check("ui mods listed", JSON.stringify(info.uiMods.map((m) => m.name)) === JSON.stringify(["app-tools", "dev-shortcuts", "gcode-lab", "mods-menu"]), info.uiMods.map((m) => m.name).join(","));
  const ui = (await invoke("usermod:list-ui-mods")).data;
  check("ui-runtime first with file URL", ui[0].name === "ui-runtime" && ui[0].url.startsWith("file:///") && ui[0].url.endsWith("/loader/ui-runtime.js"));

  check("read-file inside mod dir", (await invoke("usermod:read-file", "mods.json")).data.includes("settings"));
  const esc = await invoke("usermod:read-file", `..${sep}store.json`);
  check("read-file traversal rejected", !esc.ok && /escapes/.test(esc.message));
  const wf = await invoke("usermod:write-file", `test${sep}hello.txt`, "hi");
  check("write-file confined to data dir", wf.ok && wf.data.endsWith(`${sep}data${sep}test${sep}hello.txt`));
  const wf2 = await invoke("usermod:write-file", `..${sep}..${sep}loader${sep}main.js`, "x");
  check("write-file escaping data dir rejected", !wf2.ok);
  require("fs").rmSync(path.join(loader.MOD_DIR, "data", "test"), { recursive: true, force: true });

  const ping = await invoke("usermod:tools:ping", "yo");
  check("app-tools ping", ping.ok && ping.data.pong === "yo" && ping.data.appVersion === "1.1.0-test");
  const bad = await invoke("usermod:tools:open-url", "https://example.com");
  check("open-url rejects non-loopback", !bad.ok && /loopback/.test(bad.message));
  const good = await invoke("usermod:tools:open-url", "http://127.0.0.1:9630/docs");
  check("open-url accepts loopback", good.ok && opened.includes("http://127.0.0.1:9630/docs"));

  const rp = await invoke("usermod:run-postprocessors", "export", gcode, { fileName: "x.nc" });
  check("run-postprocessors manual", rp.ok && rp.data.includes("(File: x.nc)"));
  const rl = await invoke("usermod:reload");
  check("reload ok", rl.ok && rl.data.postprocessors.length === 4);

  const noise = (await invoke("usermod:info")).data.errors.filter((e) => !/^ipc:(read|write)-file|^mod-ipc:app-tools:tools:open-url/.test(e.scope));
  check("no unexpected loader errors", noise.length === 0, JSON.stringify(noise));
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
