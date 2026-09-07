# Mod API

Mods are TypeScript packages under `mods/`. Each declares what it provides in its `package.json`
`usermod` manifest; the loader discovers them at startup, honours `mods.json` (disabled list, per-mod
settings) and loads them in `order`. Types come from `@neststudio-usermods/types`:

- main-process code (post-processors, main mods): `"types": ["node", "@neststudio-usermods/types"]`
- renderer code (UI mods): `"types": ["@neststudio-usermods/types/renderer"]`, `"module": "None"`

## Manifest

```json
{
  "name": "@neststudio-mods/my-mod",
  "usermod": {
    "name": "my-mod",
    "postprocessor": "dist/index.js",
    "main": "dist/main.js",
    "ui": "dist/ui.js",
    "order": 100,
    "description": "one line"
  },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "devDependencies": { "@neststudio-usermods/types": "workspace:*" }
}
```

Any combination of `postprocessor`, `main` and `ui` entries is allowed. `order` sorts post-processors
(execution order) and UI mods (injection order); lower runs first, default 100. Settings live in the
repo's `mods.json` under `settings.<name>`; the installer's "Select mods" maintains `disabled`.

## Post-processors (main process)

```ts
interface Settings { factor: number }

const mod: Usermod.Postprocessor<Settings> = {
  stages: ["export"],           // "export": file saved from the app; "send": G-code sent to the machine
  includeInternal: false,       // also run on the app's scratch files (validation / time estimate)
  match(ctx) { return true; },  // optional filter
  process(gcode, ctx) {         // may be async; return the new text, or undefined to leave it unchanged
    const factor = ctx.settings.factor ?? 1;   // settings are Partial<Settings>
    ctx.log("applied", factor);
    return gcode;
  }
};
export = mod;
```

`Usermod.PostprocessorContext<S>`: `stage`, `filePath` and `fileName` (export), `fileName` and `channel`
(send), `internal`, `settings: Partial<S>`, `dataDir`, `log()`, `warn()`. Processors run sequentially;
each receives the previous output. Errors are logged and the chain continues with the unmodified text.

## UI mods (renderer)

Classic scripts (an IIFE per file) injected after the UI runtime. Globals are typed on `Window`:

### `window.usermodRuntime` (`Usermod.Runtime`)

| Member | Purpose |
| --- | --- |
| `register({ name, version })` | announce the mod (appears in logs) |
| `waitFor<E>(selector, { timeout, root })` | promise for an element the React tree will render |
| `observe(cb, root)` | MutationObserver wrapper, returns disconnect fn |
| `onRoute(cb)` | hash route changes (`/home`, `/project`, `/preview`, `/device`) |
| `addStyle(css, id)` | inject/replace a style block |
| `el(tag, props, children)` | typed element builder (`class`, `text`, `html`, `style`, `onClick`…) |
| `toast(msg, { kind, duration })` | `info`, `success`, `warn`, `error` |
| `modal(title, { width })` | returns `{ root, body, close }`; Escape/backdrop close |
| `menu.addAction({ id, label, section, order, title, onClick({ close, refresh }) })` | add a button to the MODS panel |
| `cam.version()`, `cam.postForm(endpoint, fields)` | CAM service client (`127.0.0.1:9630`) |
| `formatDuration(s)`, `formatBytes(n)` | formatting helpers |
| `api` | alias of `window.api` (the app's own preload API, `NestStudio.Api`) |

### `window.usermodUI` (`Usermod.UI`, from `packages/ui-kit`)

The toolkit for building mod UI that looks like the MODS menu. Injected after the runtime, before mods.

| Member | Purpose |
| --- | --- |
| `toolbar.addButton({ id, title, icon, onClick, order })` | button in the app bar right after the Settings gear, styled like it; returns a handle with `setIcon`, `setTitle`, `setBadge`, `remove` |
| `popover(anchor, { width, align, onClose })` | dropdown panel under an element; closes on outside click/Escape; one open at a time |
| `modal(title, { width })` | centred dialog (`{ root, body, close }`) |
| `button(label, onClick, { primary, title, disabled })`, `buttonRow([...])` | buttons; async errors become toasts |
| `section(title, children)`, `list(items, render, empty)`, `kv(pairs)` | panel building blocks |
| `toggle(label, checked, onChange, help)`, `select(...)`, `input(...)` | form controls |
| `settingsForm(modName, { title, fields, reloadPostprocessors, onSaved })` | form bound to `mods.json` `settings.<modName>`, saved through the loader |
| `icons.puzzle() / moon() / sun() / gear()`, `icons.svg(pathData)` | 22 px inline SVG icons |

Styles key off the app's `html[data-theme]`, so kit UI follows the app's light/dark theme.

```ts
const ui = window.usermodUI;
const handle = ui.toolbar.addButton({ id: "hello", title: "Hello", icon: ui.icons.gear, order: 50, onClick: (btn) => {
  const p = ui.popover(btn, { width: 320 });
  p.body.append(ui.section("Hello", ui.kv([["Route", location.hash]])), ui.settingsForm("hello", { fields: [{ key: "loud", label: "Loud", type: "boolean" }] }));
} });
```

### `window.usermod` (`Usermod.Bridge`)

`info()`, `invoke<T>(channel, ...args)`, `on<T>(channel, cb)`, `readFile(rel)`, `writeFile(rel, text)`
(confined to `data/`), `log(level, ...)`, `reload()`, `openModDir()`, `runPostprocessors(stage, gcode, ctx)`,
`setSettings(modName, settings)` (rewrites that mod's block in `mods.json`).
Every call resolves to `Usermod.IpcResult<T>`: `{ ok: true, data }` or `{ ok: false, message }`.

### `window.api` (`NestStudio.Api`, the subset that is typed)

`gcode.validate(text, toolSlots)`, `gcode.estimatedTime(text)`, `gcode.arcFit(text)`,
`dialog.showSave(opts)` / `showOpen(opts)`, `store.read()`, `store.writeFile(path, text)` (dialog-picked
paths only; goes through the post-processor hook), `shell.openExternal(url)` (allow-listed hosts only).

The CSP allows scripts from `file:` and network access to the CAM service only. Bundled UI mods:
`mods-menu`, `dark-mode`, `gcode-lab`, `app-tools`, `dev-shortcuts`.

Theme note: Nest Studio applies `data-theme="light|dark"` on `<html>` from `app.theme` in the user
store and ships full token sets for both. `dark-mode` switches it by writing the store through
`window.api.store.write` and reloading the renderer.

## Main mods (main process)

```ts
const mod: Usermod.MainMod<{ greeting: string }> = {
  description: "one line",
  activate(api) {
    api.handle("mymod:hello", async (name: unknown) => `${api.settings.greeting ?? "hi"} ${String(name)}`);
    api.send("mymod:event", { any: "payload" });   // UI: usermod.on("mymod:event", cb)
  }
};
export = mod;
```

`Usermod.MainModApi<S>`: `name`, `electron`, `app`, `modDir`, `distDir`, `dataDir`, `settings`,
`whenReady()`, `log/warn/error`, `handle(channel, fn)`, `send(channel, payload)`, `getMainWindow()`,
`readStore()`, `runPostprocessors()`. Handler results become `{ ok: true, data }`, thrown errors
`{ ok: false, message }`. Main mods have full Node access and load once at startup.

Bundled: `app-tools` (`tools:ping`, `tools:open-logs`, `tools:open-userdata`, `tools:open-usermod-log`,
`tools:open-url` (loopback only), `tools:cam-status`, `tools:tool-library`).

## Loader internals

`packages/loader/src/main.ts` is required as the first statement of the app's main script. It
monkey-patches `ipcMain.handle` so it can wrap `store:write-file` and the two send channels when the app
registers them, registers the `usermod:*` IPC surface, loads post-processors and main mods from the
manifests, and lists UI mods for the preload to inject. `preload.ts` compiles to a block that the
installer appends to the app preload; `ui-runtime.ts` is the first script injected into the page. Logs
go to `usermod.log` in the repo root (rotates at 2 MB).
