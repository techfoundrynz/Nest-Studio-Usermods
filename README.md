# NestStudio_UserMods

A user-mod loader for [Nest Studio](https://www.nestworks.ai) (Nestworks desktop CNC software, Electron
+ Python CAM service) plus a set of bundled mods, written in TypeScript and organised as a pnpm
workspace. It adds:

- **Post-processors**: typed transforms applied to every G-code file the app exports (and, optionally,
  to G-code sent to the machine).
- **UI mods**: scripts injected into the app's renderer. Each one owns an icon in the app bar next to the
  Settings gear; the bar keeps five and collapses the rest into an ellipsis menu.
- **Main mods**: main-process extensions with full Node access, exposed to UI mods over IPC.
- **Update-proof install**: an interactive installer rebuilds `app.asar` and can be re-run after every
  app update.

Tested against Nest Studio 1.1.0 (Electron 39.8.10) on Windows 11 and macOS (Apple Silicon). Modifying
the app may be against the vendor's terms of use; the `send` stage changes what reaches a real machine.
Use with care. Licensed under the GPL-3.0 (see `LICENSE`).

## Install

Requirements: Node.js 20+, pnpm 10+ (`corepack enable` or `npm i -g pnpm`), Nest Studio installed in
`C:\Program Files\nest-studio` on Windows or `/Applications/Nest Studio.app` on macOS (pass
`--install-root=<dir>` otherwise; on macOS it points at the `.app` bundle).

```powershell
git clone <this repo> C:\Repos\NestStudio_UserMods
cd C:\Repos\NestStudio_UserMods
pnpm install
pnpm run install:app          # interactive menu; the final copy step needs an elevated terminal
```

On macOS the final copy step needs permission to modify another app's bundle: grant your terminal
**App Management** access (System Settings ▸ Privacy & Security ▸ App Management) or run the install
with `sudo`. Swapping `app.asar` breaks the bundle's code-signature seal; an already-approved app keeps
launching (Gatekeeper only checks the seal on first launch, and this build's asar-integrity fuse is
off), but if macOS ever refuses to start it:
`xattr -dr com.apple.quarantine "/Applications/Nest Studio.app" && codesign --force --deep --sign - "/Applications/Nest Studio.app"`
(ad-hoc re-signing resets TCC grants such as camera access, and in-app auto-update may need a fresh
download afterwards). `pnpm run uninstall:app` restores the untouched original archive, and with it the
vendor signature.

The menu offers **Install / re-install**, **Build only**, **Enable / disable mods** and **Uninstall**.
Under the hood the installer builds the workspace, extracts `resources\app.asar` into `build\app`,
applies marker-based patches, verifies the patched main script still parses, repacks to
`build\app.asar`, backs up the original as `resources\app.asar.orig`, and copies the patched archive
into place. Nest Studio must be closed for the copy.

**The toolbar.** Every enabled mod with UI adds one icon after the Settings gear. Five stay in the bar and
the rest collapse into an ellipsis (…) menu; raise the limit or pin the mods you want kept visible under
MODS ▸ Toolbar. Mods whose click is a direct action (dark mode, isometric view) put their settings on a
right-click, and app-tools opens a small menu.

**Choosing mods.** Everything except the MODS menu itself is off after install. Open the MODS menu in
the app and click **Mods…** to switch mods on. Save does whatever the toggled mods need: post-processors
apply at once, a UI mod change reloads the UI automatically, and switching a main-process mod off offers
an app restart (mods can override this with a `reload` manifest field). The CLI is the fallback if a mod ever
breaks the UI: `pnpm run mods` (picker), or `pnpm run install:app -- --disable-mods=a,b`,
`--enable-mods=a,b`, `--disable-all-mods`. These only edit `mods.json`; no rebuild needed.

**Versions.** `versions.json` lists the Nest Studio versions the patches have been verified against. For
any other version the installer warns and asks (non-interactive runs need `--allow-untested`). Patches
are anchor-based and a parse check guards the main script, so new versions usually just work; add them
to the file once confirmed.

Non-interactive equivalents:

| Command | Purpose |
| --- | --- |
| `pnpm run install:app -- --install` | install, or re-install after an app update (no-op if current) |
| `pnpm run install:app -- --install --force` | rebuild even if current |
| `pnpm run install:app -- --install --devtools` | build option: re-enable Chromium DevTools (the app ships with them off); `F12` (app-tools) or MODS ▸ Developer toggles them |
| `pnpm run install:app -- --install --cam-docs` | build option: start the CAM service with `ENABLE_DOCS=1` so Swagger is at `127.0.0.1:9630/docs` |
| `pnpm run install:app -- --install --multi-side` | build option: more than two machining sides. Keeps the Flip Setup "+" after the second side and tiles extra flip platforms; generation, preview face switching, per-face export and the machining queue already handle any number |

Build options are baked into the patched archive. The interactive install asks for them; `--no-devtools` /
`--no-cam-docs` / `--no-multi-side` turn them off again. The MODS panel shows which ones the installed build
carries.

**More than two sides.** With `--multi-side` the Flip Setup panel keeps its "+" button, so a project can have
any number of machining sides (each a 180° flip about X or Y of the previous stock orientation). Everything
downstream already handles N sides: per-side toolpath generation, the Preview face switcher, one exported
program per side, and the machine's job queue that asks you to flip and continue after each face. Two things
stay two-sided in the app itself: the CAM service pairs support-tab data between "the" top face and each
bottom face, and the material simulation always starts a face from fresh stock (the final-geometry mod
compares one face at a time for the same reason).
| `pnpm run build:asar` | build `build\app.asar` without touching the install (no admin) |
| `pnpm run mods` | CLI fallback for enabling/disabling mods (writes `mods.json`) |
| `pnpm run uninstall:app` | restore `app.asar.orig` |
| `tools\install.ps1 [args]` | thin PowerShell wrapper for elevated shells (Windows) |

The repo folder **is** the live mod directory: the patched app requires
`packages\loader\dist\main.js` from wherever you ran the installer, and mods load from `mods\*\dist`
at runtime. Keep the folder in place, or re-run the installer after moving it.

## Workspace layout

```
packages/
  types/       @neststudio-usermods/types      ambient .d.ts: Usermod.* and NestStudio.* (main + renderer variants)
  loader/      @neststudio-usermods/loader     main.ts (main-process loader), preload.ts (bridge), ui-runtime.ts, tests/
  asar/        @neststudio-usermods/asar       dependency-free asar extract/pack/list/cat (library + nest-asar CLI)
  installer/   @neststudio-usermods/installer  interactive installer (tsx + prompts)
  ui-kit/      @neststudio-usermods/ui-kit     window.usermodUI: toolbar buttons, popovers, modals, forms, settings forms; imperative DOM helpers
                                               plus bundled React 19 with matching components and hooks (usermodUI.react) for TSX mods
mods/
  feed-override, arc-fit, tool-change-guard, program-header, safe-shutdown, peck-drill,
  gcode-format, tool-split, export-copy                                                     (post-processors)
  mods-menu, dark-mode, gcode-lab, iso-view, status-hud, device-macros, tool-change-assistant,
  jog, cycles, feeds-speeds, live-override, z-probe, work-offsets, toolpath-color, tool-visual,
  tool-library                                                                              (UI)
  machine-state, camera-timelapse, project-backup, export-filename                          (main)
  app-tools, jobs, ui-scale, export-report, lan-monitor, final-geometry, toolpath-modifiers (main/post + UI)
mods.default.json   tracked template: enabled list (empty) + default settings
mods.json           per-machine copy (git-ignored), created from the template on first run, edited by Mods… / settings forms
docs/          launch-options.md, architecture.md, mod-api.md
build/, data/, usermod.log, **/dist   generated, git-ignored
```

Each mod is a package whose `package.json` carries a `usermod` manifest:

```json
"usermod": { "name": "program-header", "postprocessor": "dist/index.js", "order": 20, "description": "..." }
```

Keys: `postprocessor`, `ui`, `main` (entry files, any combination), `order` (load/run order, default 100),
`name`, `description`, `core` (always on, not user-toggleable; only `mods-menu` uses it), `reload`
(`none` / `ui` / `app`, normally derived from the kinds; see docs/mod-api.md). The loader
discovers every `mods/*/package.json` with a manifest at startup and loads those listed in `mods.json`
`enabled`.

## Bundled mods

| Mod | Kind | What it does |
| --- | --- | --- |
| `program-header` | post | Comment block after the app header: file, date, lines, tools, feed/spindle range, XYZ bounds |
| `safe-shutdown` | post | Inserts `M5`/`M9` before `M30` when spindle/coolant were left on; appends `M30` if missing |
| `feed-override` | post | Scale/clamp `F` and `S` words (no-op at factor 1) |
| `arc-fit` | post | Runs the bundled ArcWelder on every export: G1 segment chains become G2/G3 arcs (much smaller reliefs) |
| `tool-change-guard` | post | Before each tool change: M5/M9 if running, machine-coordinate retract, optional M0 pause for manual bit swaps |
| `export-copy` | post | Also writes each export to a folder (USB stick, network share) once `targetDir` is set |
| `jobs` | main + ui | Desktop toast / webhook when a run finishes, alarms or pauses; run history (program, tools, duration, outcome) with totals and CSV export |
| `export-report` | post + ui | JSON stats report per export (bounds, tools, feeds) plus depth, low-rapid and envelope checks; "Last export report…" in the menu, a warning dialog when a check fails |
| `jog` | ui | Keyboard (arrows / PgUp / PgDn, Escape stops) and game-controller jogging over one guarded jog engine |
| `gcode-format` | post | Strip comments / blank lines and add `N` line numbers, each switchable in its settings (both off by default) |
| `iso-view` | ui | Toolbar toggle between perspective and an isometric-style view of the 3D scene; right-click for Top/Front/Right/Iso/Reset |
| `tool-visual` | ui | Rebuilds the preview's cutter model per toolpath from the tool library (flat, ball, taper/V, drill); the app uses one fixed bit |
| `cycles` | ui | Cycle generators: thread milling (internal/external, RH/LH), helical hole milling, spoilboard surfacing; validate, preview, export via the chain |
| `peck-drill` | post | Deep straight plunges become peck cycles with chip-clearing retracts |
| `tool-split` | post | One extra file per tool section next to every multi-tool export, each with preamble and safe footer |
| `live-override` | ui | Feed / spindle / rapid override buttons (GRBL realtime commands) with the live FS readout |
| `z-probe` | ui | Touch-plate Z zero wizard (G38.2, two-stage) that sets the work Z; offered in the tool-change dialog |
| `work-offsets` | ui | G54–G59 switching, set zero here, named machine positions with go-to and zero-at |
| `lan-monitor` | main + ui | Read-only status page on the LAN with progress, ETA and the latest camera frame |
| `feeds-speeds` | ui | Chip-load calculator per material against the tool library, with favourites |
| `toolpath-modifiers` | main + ui | Runs chosen post-processors on each toolpath as the CAM generates it, so the Preview tab, the saved project and the export carry the result (export/send skip what was already applied) |
| `tool-library` | ui | Export selected tools to JSON and import from JSON or another store.json, resolving id and slot clashes |
| `final-geometry` | main + ui | Runs the material simulation to the end and compares the machined stock with the model: rest material, overcuts, volumes, ghost overlay, STL export of the machined stock |
| `toolpath-color` | ui | Preview toolpaths coloured by depth or per operation; hover a list row to highlight its path |
| `machine-state` | main | Shared machine status, positions (MPos/WPos), WCS, feed/spindle, progress / ETA (`machine:state`) for other mods; optional console log |
| `status-hud` | ui | Always-visible status pill with progress bar and ETA; click for details |
| `device-macros` | ui | Toolbar button with user-defined G-code / command macros (with confirmation) |
| `tool-change-assistant` | ui | When the machine holds at a tool change, names the tool from the library and offers Resume |
| `camera-timelapse` | main | Saves camera frames to `data/timelapse/<job>` every N seconds while a job runs |
| `project-backup` | main | Timestamped copies of every saved project zip in `data/backups`, newest N kept |
| `export-filename` | main | Pre-fills the export dialog from a template (`{name} {project} {date} {time}`) and default folder |
| `mods-menu` | ui | App-bar button and panel: status, mod actions, reload post-processors / UI |
| `dark-mode` | ui | Sun/moon toolbar button that switches Nest Studio's built-in dark theme; optional follow-OS setting |
| `ui-scale` | ui + main | UI zoom (`Ctrl+=` / `Ctrl+-` / `Ctrl+0`, remembered) and a compact density mode that tightens the app's spacing tokens |
| `gcode-lab` | ui | Drop any G-code file: stats, post-processor preview, validate, time estimate, export via chain |
| `app-tools` | ui + main | Open app logs / user data / usermod.log, CAM service status, API docs; `Ctrl+Shift+M` panel, `Ctrl+Shift+R` reload UI, `Ctrl+Shift+L` open log, `F12` DevTools |

All of these start switched off; enable them from MODS ▸ Mods…. Settings changes apply after "Reload
post-processors" in the MODS panel; UI mods after a UI reload (`Ctrl+Shift+R` with app-tools on), main mods at app start.

## Development

```powershell
pnpm run build      # tsc for every package and mod
pnpm run watch      # loader + all mods in watch mode (concurrently)
pnpm test           # build, then run the loader harness under a stubbed Electron
```

Third-party versions are pinned once in the `catalog:` section of `pnpm-workspace.yaml`; packages declare
`"catalog:"` instead of a version (`catalogMode: strict` makes `pnpm add` refuse anything else). Bump a version
there and run `pnpm install`.

Writing a mod: copy one of the `mods/*` packages, edit `src/index.ts` against the `Usermod.*` types,
add the `usermod` manifest, run `pnpm install` (links the types package) and `pnpm run build`. UI mods
build on `window.usermodUI` (toolbar buttons next to the Settings gear, popovers, modals, form and
settings helpers), either imperatively (`mods/dark-mode`, `mods/iso-view`) or in React/TSX through
`usermodUI.react`, which bundles React 19 with components and hooks (`mods/mods-menu`, `mods/gcode-lab`,
`mods/device-macros` are the references; no per-mod bundler, TSX compiles to one injected script). See
[docs/mod-api.md](docs/mod-api.md) for the API, [docs/architecture.md](docs/architecture.md) for how the
app is put together and why the installer repacks the archive, and
[docs/launch-options.md](docs/launch-options.md) for environment variables, switches, ports and helper
executables (including `ENABLE_DOCS=1` for the CAM service's Swagger UI).
