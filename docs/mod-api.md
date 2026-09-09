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
(execution order) and UI mods (injection order); lower runs first, default 100. `core: true` marks a mod
that always loads and cannot be switched off (only `mods-menu`).

`reload` (`"none" | "ui" | "app"`) tells the Enable/disable mods window what must happen after the mod is switched on
or off. Leave it out and it is derived: `postprocessor` → `none` (applies at once), `ui` → `ui` (the dialog
reloads the renderer automatically on Save), `main` → `app` when switching off (main mods cannot unload;
the dialog offers a restart, after checking for unsaved projects) and immediate activation when switching
on. Declare it only to override, e.g. `"reload": "app"` for a UI mod that patches something it cannot undo. Mods are opt-in: the loader loads those
named in `mods.json` `enabled`, which the in-app Enable/disable mods window (or the installer's CLI fallback) writes.
Settings live in `mods.json` under `settings.<name>`.

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
(send), `endpoint` (preview), `internal`, `settings: Partial<S>`, `dataDir`, `log()`, `warn()`. Processors
run sequentially; each receives the previous output. Errors are logged and the chain continues with the
unmodified text.

Stages: `export` and `send` are chosen by the processor's `stages`. `preview` is chosen by the user in the
toolpath-modifiers mod (settings `toolpath-modifiers.preview`, a list of processor names): those run on every
toolpath the CAM service returns, one operation's G-code at a time, so the Preview tab, the saved project and
the export all carry the result. The loader prefixes such G-code with `(usermod-preview-applied: a, b)` and
skips the named processors again at export and send. Whole-program processors (headers, footers, file
splitting, reports) belong at export.

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
| `modal(title, { width })` | returns `{ root, body, footer, close }`; Escape/backdrop close. `width` is a floor, not a ceiling: the dialog sizes to its content and caps at 90% of the window. Put action buttons in `footer` and scrolling cannot hide them (it stays invisible while empty) |
| `menu.addAction({ id, label, section, order, title, icon, onClick({ close, refresh }) })` | legacy: listed in the toolbar overflow menu under its section heading. New mods should own a toolbar button instead |
| `cam.version()`, `cam.postForm(endpoint, fields)` | CAM service client (`127.0.0.1:9630`) |
| `formatDuration(s)`, `formatBytes(n)` | formatting helpers |
| `api` | alias of `window.api` (the app's own preload API, `NestStudio.Api`) |

### `window.usermodUI` (`Usermod.UI`, from `packages/ui-kit`)

The toolkit for building mod UI that looks like the MODS menu. Injected after the runtime, before mods. Every
helper below has a React twin under `ui.react` (next section); pick whichever fits the mod.

| Member | Purpose |
| --- | --- |
| `toolbar.addButton({ id, title, icon, onClick, order, pinned })` | button in the app bar right after the Settings gear, styled like it; returns a handle with `setIcon`, `setTitle`, `setBadge`, `remove` |
| `toolbar.setMaxVisible(n)` / `maxVisible()` / `setOrder(ids)` / `order()` / `setPinned(ids)` / `entries()` | how many icons stay in the bar (default 5) and in what order; `entries()` reports position and visibility |
| `menu(anchor, items, { width, align })` | popover of clickable rows (`{ label, onClick, icon, title, hint, disabled }`, or `{ heading }` to group); the toolbar's overflow menu is one of these |
| `provide(name, api)` / `consume<T>(name)` / `provided()` | the one place mods reach each other (see below); nothing goes on `window` |
| `popover(anchor, { width, align, onClose })` | dropdown panel under an element; closes on outside click/Escape; one open at a time |
| `modal(title, { width, onClose })` | centred dialog (`{ root, body, footer, close, isOpen }`), content-sized up to 90% of the window |
| `button(label, onClick, { primary, title, disabled })`, `buttonRow([...])` | buttons; async errors become toasts |
| `section(title, children)`, `list(items, render, empty)`, `kv(pairs)` | panel building blocks |
| `toggle(label, checked, onChange, help)`, `select(...)`, `input(...)` | form controls |
| `settingsForm(modName, { title, fields, reloadPostprocessors, onSaved })` | form bound to `mods.json` `settings.<modName>`, saved through the loader |
| `icons.puzzle() / moon() / sun() / gear()`, `icons.svg(pathData)` | 22 px inline SVG icons |

Styles key off the app's `html[data-theme]`, so kit UI follows the app's light/dark theme.

**One icon per mod.** Every bundled mod with UI registers exactly one toolbar button, and that button either
opens the mod's UI or performs its action, never both. A mod with several actions (app-tools) opens `ui.menu`
from its button; a mod with several panels (work-zero) opens a window with a tab per panel, and `view` stacks its sections in one window. The
bar shows at most `toolbar.maxVisible()` usermod icons
(default 5, from `mods.json` `settings.mods-menu.toolbarMaxVisible`) and collapses the rest into an ellipsis
button whose menu lists the hidden mods plus any legacy `rt.menu.addAction` entries.
`settings.mods-menu.toolbarOrder` is the user's arrangement (edited in MODS ▸ Enable/disable mods ▸ Toolbar):
listed ids come first in that order, the rest follow by their own `order`, and the top of the list is what stays
in the bar. mods-menu pins itself first with `pinned: true`. Each mod gets exactly one row in the overflow menu, running exactly what its
button runs: a mod either opens its UI or performs its action, never both.

```ts
const ui = window.usermodUI;
const handle = ui.toolbar.addButton({ id: "hello", title: "Hello", icon: ui.icons.gear, order: 50, onClick: (btn) => {
  const p = ui.popover(btn, { width: 320 });
  p.body.append(ui.section("Hello", ui.kv([["Route", location.hash]])), ui.settingsForm("hello", { fields: [{ key: "loud", label: "Loud", type: "boolean" }] }));
} });
```

### Mods reaching each other: `ui.provide` / `ui.consume`

A mod that wants to offer something to the others publishes it under a name it owns, and the other looks it
up when it needs it:

```ts
// work-zero
ui.provide("probe", { run: () => openWizard(), enabled: () => offerAtToolChange });

// tool-change, when the machine holds at a change
interface Probe { run(): Promise<void>; enabled(): boolean }
const probe = ui.consume<Probe>("probe");   // null when work-zero is switched off
```

The registry lives in the kit, not on `window`, so no mod's private handle appears in the shared `Window`
interface: that stays down to the four things every renderer script gets (`usermodRuntime`, `usermodUI`,
`usermod`, `api`) plus the globals the installer patches into the app itself. Like `usermod.invoke<T>` and
`api.call<T>` in the main process, the caller names the shape it expects, and `null` means that mod is not
running. `ui.provided()` lists what is published. Only two links exist today: mods-menu publishes its panel
for app-tools's `Ctrl+Shift+M`, and work-zero publishes the probe wizard for tool-change.

### `window.usermod` (`Usermod.Bridge`)

`info()`, `invoke<T>(channel, ...args)`, `on<T>(channel, cb)`, `readFile(rel)`, `writeFile(rel, text)`
(confined to `data/`), `log(level, ...)`, `reload()`, `openModDir()`, `runPostprocessors(stage, gcode, ctx)`,
`setSettings(modName, settings)` (rewrites that mod's block in `mods.json`), `setEnabled(names)` (rewrites
`enabled`; post-processors reload and newly enabled main mods activate immediately).
`info()` includes `available` (every mod package with `enabled`, `core`, `kinds`) and `buildFlags` (which
installer build options the installed archive carries).
Every call resolves to `Usermod.IpcResult<T>`: `{ ok: true, data }` or `{ ok: false, message }`.

### `window.api` (`NestStudio.Api`, the subset that is typed)

`gcode.validate(text, toolSlots)`, `gcode.estimatedTime(text)`, `gcode.arcFit(text)`,
`dialog.showSave(opts)` / `showOpen(opts)`, `store.read()`, `store.writeFile(path, text)` (dialog-picked
paths only; goes through the post-processor hook), `shell.openExternal(url)` (allow-listed hosts only).

The CSP allows scripts from `file:` and network access to the CAM service only. Bundled UI mods:
`mods-menu`, `appearance`, `gcode-lab`, `app-tools` (which also carries the developer shortcuts).

Theme note: Nest Studio applies `data-theme="light|dark"` on `<html>` from `app.theme` in the user
store and ships full token sets for both. `appearance` switches it by writing the store through
`window.api.store.write` and reloading the renderer.

## React UI mods (TSX)

The kit bundles React 19 + ReactDOM. `window.usermodUI.react` (`Usermod.ReactKit`) is the React face of the
same toolkit; the imperative helpers and these components emit the same class names, so both looks are
identical and can be mixed. The kit also publishes the classic UMD globals `window.React` / `window.ReactDOM`,
so a mod compiled with `"jsx": "react"` needs nothing else: JSX becomes `React.createElement` against that
global and the mod is still one plain injected script. It is a separate React from the app's own: mount only
into DOM you own (kit modal / popover bodies, your own elements), never into the app's tree.

| Member | Purpose |
| --- | --- |
| `mount(container, element)` | render into an element you own; returns an unmount function (one root per container) |
| `modal(title, element, { width, onClose, footer })`, `popover(anchor, element, options)` | kit containers whose body is a React tree, unmounted automatically on close |
| `<ModalFooter>` | renders its children into the modal's pinned footer from anywhere inside the modal's tree, so the buttons keep the state that sits next to them; nothing outside a kit modal |
| `Section`, `Sub`, `KV`, `List`, `Row`, `Mono`, `Err`, `Loading` | layout / display twins of `section`, `kv`, `list`, `buttonRow`… |
| `Button`, `Toggle`, `Select`, `Input` | controls; `Button` turns async errors into toasts like `ui.button()` |
| `SettingsForm` | `ui.settingsForm()` as a component (`modName`, `fields`, `reloadPostprocessors`, `onSaved`) |
| `useInfo()`, `useInvoke<T>(channel, args)`, `useAsync(fn, deps)` | `{ data, error, loading, refresh }` for loader data |
| `useEvent<T>(channel, handler)` | `usermod.on` for the component's lifetime |
| `useMachineState()` | live `Usermod.MachineState` from the machine-state mod |
| `useRoute()` | current hash route |

Mod tsconfig for TSX (types come through the normal renderer entry, which includes `types/react`):

```json
{
  "compilerOptions": {
    "module": "None",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["@neststudio-usermods/types/renderer"],
    "jsx": "react",
    "rootDir": "src", "outDir": "dist"
  },
  "include": ["src/index.tsx"]
}
```

with `@types/react` / `@types/react-dom` pinned in the mod's devDependencies. Hooks are `React.useState(...)`
off the global namespace. Pattern:

```tsx
const ui = window.usermodUI;
const { Section, KV, Button, Row, useMachineState } = ui.react;
function Panel(): React.JSX.Element {
  const m = useMachineState();
  return <Section title="Machine">{m ? <KV pairs={[["Status", m.status ?? "—"]]} /> : "no data"}</Section>;
}
ui.toolbar.addButton({ id: "x", title: "Machine panel", icon: () => ui.icons.svg("M4 4h16v12H4z"), order: 50, onClick: () => ui.react.modal("Machine", <Panel />, { width: 420 }) });
```

References: `mods/mods-menu` (status panel + the Enable/disable mods window), `mods/gcode-lab` (drop zone, async actions),
`mods/device-macros` (popover + editor form), `mods/jobs` and `mods/export` (panels with settings forms).
Some mods stay imperative on purpose: `appearance`'s compact-density CSS, `view`'s camera work and `jobs`'s status pill patch the app's own DOM.

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
`events`, `readStore()`, `runPostprocessors()`, `call<T>(channel, ...args)`. Handler results become
`{ ok: true, data }`, thrown errors `{ ok: false, message }`. Main mods have full Node access and load once
at startup. `api.call` invokes another main mod's handler in-process (e.g.
`api.call<Usermod.MachineState>("machine:state")`), so mods can build on each other without IPC; it rejects
when no active mod handles the channel.

`api.events.on(name, listener)` subscribes to loader events (`Usermod.LoaderEvents`):
`gcode-sent` `{ channel, fileName, lines, bytes, runTimeSeconds?, gcode }` after G-code goes to the
machine, and `gcode-exported` `{ filePath, fileName, lines, bytes, internal }` after a file export.

`api.intercept(channel, { before?(args), after?(result, args) })` hooks any of the app's own IPC invoke
channels. `before` may return replacement arguments, `after` a replacement result; errors are logged and
skipped. Examples in the bundled mods: `export` rewrites `dialog:show-save` options,
`project-backup` watches `store:write-binary-file` and the chunked `store:begin/finish-binary-file-write`.
Channel names come from the app's preload (`out/preload/index.js`); the loader's `usermod.log` and the
IPC inspector idea in the README are the way to discover more.

The `machine-state` mod turns the device stream into `machine:state` (`Usermod.MachineState`; invoke for
current, `usermod.on` for updates): `{ connected, status, alarm, phase, line, job: { fileName, lines,
runTimeSeconds, startedAt, toolChanges }, elapsedSeconds, progress, etaSeconds, mpos, wpos, wcs, feed,
spindle, tool, lastError }`. `machine:console` (`Usermod.MachineConsoleLine`) carries error, alarm and probe
result lines only. Build on these rather than parsing status frames again; `useMachineState()` in the kit
subscribes for React components.

Machine dialect notes (Nest Studio 1.1): the app sends realtime commands spelled out as text (`"0x85"` for
jog cancel), zeroes with `G10 L20 P<G-53> …` where `G` is the active WCS from the status frame, homes with
`$H`, and jogs with `$J=G21G91…F…`. Feed and spindle overrides are **absolute percentages**, not GRBL's
relative bytes: feed `0xC0` (0%) to `0xCF` (150%) and spindle `0xD0` (50%) to `0xD7` (120%), in steps of 10
(see `mods/overrides`). Status frames carry `MPos`, `WPos`, `FS`, `Ln`, `G`, `T` and machine
specific `MS` flags.

Machine envelope: the renderer hard-codes X 238 mm, Y 200 mm, Z 123 mm of travel and a 225 mm work platform.
With the installer's `--bed-size` option those constants read `globalThis.__usermodBed` / `__usermodBedPlatform`
instead, which the loader's preload fills in synchronously (`ipcMain.on("usermod:bed-sync")`, so the values are
there before the app's chunks evaluate) from the `bed-size` mod's settings. Travel limits are re-read on every
check; the work-platform size is read once, so it needs a UI reload.

3D scene access: the installer exposes the app's three.js `SceneManager` instances as
`globalThis.__usermodSceneManagers` (typed minimally as `UsermodSceneManagerLike`); `mods/view` shows
how to drive the app's `CameraController` (target, distance, orientation quaternion) safely. To observe what
the app streams to its renderer (machine status, console lines), wrap `webContents.send` from
`app.on("web-contents-created")` as `mods/machine-state` does (and then prefer `api.events.on("machine-state")`
over doing it again); the `device:stream-event` payloads of
type `machine_status` carry `status` (`Idle`, `Run`, `Hold`, `Alarm`, …) and the line counter `Ln`.

Bundled: `app-tools` (`tools:ping`, `tools:open-logs`, `tools:open-userdata`, `tools:open-usermod-log`,
`tools:open-url` (loopback only), `tools:cam-status`, `tools:tool-library`) and `jobs` (`jobs:status`,
`jobs:test`, `jobs:reload-settings`, `jobs:list`, `jobs:clear`, `jobs:export-csv`, `jobs:open`; emits
`jobs:event` and `jobs:changed` to the UI).

Renaming or merging a mod would orphan its `mods.json` entry, so the loader carries a migration table
(`MIGRATIONS` in `packages/loader/src/main.ts`) mapping an old mod name onto the current one: the old name
enables the new mod, its settings are carried over (`pick()` renames keys), and the file is rewritten once
with a line in `usermod.log`. The table is deliberately empty, because nothing has shipped to anyone yet; add
an entry the next time a name changes under someone's feet. `applyMigrations()` is the pure half and is what
the test harness exercises.

## Loader internals

`packages/loader/src/main.ts` is required as the first statement of the app's main script. It
monkey-patches `ipcMain.handle` so it can wrap `store:write-file` and the two send channels when the app
registers them, registers the `usermod:*` IPC surface, loads post-processors and main mods from the
manifests, and lists UI mods for the preload to inject. `preload.ts` compiles to a block that the
installer appends to the app preload; `ui-runtime.ts` is the first script injected into the page. Logs
go to `usermod.log` in the repo root (rotates at 2 MB).
