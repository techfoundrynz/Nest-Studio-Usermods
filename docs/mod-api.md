# Mod API

Three kinds of mods, all plain JavaScript files, loaded in file-name order. A mod is disabled when its
file name starts with `_` or its name is listed in `mods.json` `disabled`. Per-mod settings live in
`mods.json` under `settings.<name>`.

## Post-processors (`postprocessors/*.js`, main process)

```js
module.exports = {
  name: "my-post",              // defaults to the file name
  description: "one line",      // shown in the MODS panel
  stages: ["export"],           // "export": file saved from the app; "send": G-code sent to the machine
  includeInternal: false,       // also run on the app's scratch files (validation / time estimate)
  match(ctx) { return true; },  // optional filter
  process(gcode, ctx) {         // may be async; return the new text, or undefined to leave it unchanged
    return gcode;
  }
};
```

`ctx`: `stage`, `filePath` and `fileName` (export), `fileName` and `channel` (send), `internal`,
`settings`, `dataDir`, `log(...)`, `warn(...)`. Processors run sequentially; each receives the previous
output. Errors are logged and the chain continues with the unmodified text. The panel's
"Reload post-processors" re-reads these files and `mods.json` without restarting.

Bundled: `feed-override`, `program-header`, `safe-shutdown`, `export-copy` (z- prefix so it runs last);
disabled examples `_strip-comments`, `_line-numbers`.

## UI mods (`ui/*.js`, renderer)

Classic scripts injected after `loader/ui-runtime.js`. Globals:

### `window.usermodRuntime` (rt)

| Member | Purpose |
| --- | --- |
| `register({ name, version })` | announce the mod (appears in logs) |
| `waitFor(selector, { timeout, root })` | promise for an element the React tree will render |
| `observe(cb, root)` | MutationObserver wrapper, returns disconnect fn |
| `onRoute(cb)` | hash route changes (`/home`, `/project`, `/preview`, `/device`) |
| `addStyle(css, id)` | inject/replace a style block |
| `el(tag, props, children)` | tiny element builder (`class`, `text`, `html`, `style`, `onClick`…) |
| `toast(msg, { kind, duration })` | `info`, `success`, `warn`, `error` |
| `modal(title, { width })` | returns `{ root, body, close }`; Escape/backdrop close |
| `menu.addAction({ id, label, section, order, title, onClick({ close, refresh }) })` | add a button to the MODS panel |
| `cam.version()`, `cam.postForm(endpoint, fields)` | CAM service client (`127.0.0.1:9630`) |
| `formatDuration(s)`, `formatBytes(n)` | formatting helpers |
| `api` | alias of `window.api` (the app's own preload API) |

### `window.usermod` (bridge to main)

`info()`, `invoke(channel, ...args)`, `on(channel, cb)`, `readFile(rel)`, `writeFile(rel, text)` (confined
to `data/`), `log(level, ...)`, `reload()`, `openModDir()`, `runPostprocessors(stage, gcode, ctx)`.
Every call resolves to `{ ok, data }` or `{ ok: false, message }`.

### `window.api` (the app's API, useful bits)

`gcode.validate(text, toolSlots)`, `gcode.estimatedTime(text)`, `gcode.arcFit(text)`,
`dialog.showSave(opts)` / `showOpen(opts)`, `store.read()`, `store.writeFile(path, text)` (dialog-picked
paths only; goes through the post-processor hook), `device.*`, `shell.openExternal(url)` (allow-listed
hosts only).

CSP allows scripts from `file:` and network access to the CAM service only. Bundled UI mods:
`mods-menu` (app-bar button + panel), `gcode-lab`, `app-tools`, `dev-shortcuts`.

## Main mods (`main/*.js`, main process)

```js
module.exports = {
  description: "one line",
  activate(api) {
    api.handle("mymod:hello", async (name) => `hi ${name}`);  // UI: usermod.invoke("mymod:hello", "x")
    api.send("mymod:event", { any: "payload" });              // UI: usermod.on("mymod:event", cb)
  }
};
```

`api`: `name`, `electron`, `app`, `modDir`, `dataDir`, `settings`, `whenReady()`, `log/warn/error`,
`handle(channel, fn)`, `send(channel, payload)`, `getMainWindow()`, `readStore()`, `runPostprocessors()`.
Handlers are wrapped: return values become `{ ok: true, data }`, thrown errors `{ ok: false, message }`.
Main mods have full Node access; they load once at startup (restart the app after editing).

Bundled: `app-tools` (`tools:ping`, `tools:open-logs`, `tools:open-userdata`, `tools:open-usermod-log`,
`tools:open-url` (loopback only), `tools:cam-status`, `tools:tool-library`).

## Loader internals

`loader/main.js` is required as the first statement of the app's main script. It monkey-patches
`ipcMain.handle` so it can wrap `store:write-file` and the two send channels when the app registers
them, registers the `usermod:*` IPC surface, loads post-processors and main mods, and lists UI mods
for the preload to inject. `loader/preload.js` is spliced verbatim into the app preload;
`loader/ui-runtime.js` is the first script injected into the page. Logs go to `usermod.log` in the
repo root (rotates at 2 MB).
