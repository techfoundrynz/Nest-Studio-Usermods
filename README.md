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
the rest collapse into an ellipsis (…) menu. MODS ▸ **Enable/disable mods** is the one window for all of it:
tick the mods you want, see what each provides and whether it is loaded, set how many icons stay in the bar,
and move them into the order you want. Mods whose click is a direct action (dark mode, isometric view) put
their settings on a right-click, and app-tools opens a small menu; in the ellipsis menu those settings appear
as their own row.

**Choosing mods.** Everything except the MODS menu itself is off after install. Open the MODS menu in
the app and click **Enable/disable mods** to switch mods on. Save does whatever the toggled mods need: post-processors
apply at once, a UI mod change reloads the UI automatically, and switching a main-process mod off offers
an app restart (mods can override this with a `reload` manifest field). Toolbar changes in the same window
apply as you make them. The CLI is the fallback if a mod ever
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
| `pnpm run install:app -- --install --bed-size` | build option: let the `bed-size` mod tell the app how much travel the machine really has (it hard-codes X 238, Y 200, Z 123 mm and a 225 mm work platform) |
| `pnpm run install:app -- --install --stock-sim` | build option: turn on the app's material simulation, which it ships switched off (`ENABLE_STOCK_REMOVAL_SIMULATION = false`). Adds the Preview tab's toolpath/material toggle and is required by `final-geometry` |

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
  feed-scale, arc-fit, tool-change, program-header, safe-shutdown, peck-drill, gcode-format,
  tool-split, export                                                                        (post-processors)
  mods-menu, appearance, view, bed-size, jog, work-zero, overrides, device-macros, tools,
  cycles, gcode-lab, cutter, feeds-speeds                                                   (UI)
  machine-state, timelapse, project-backup                                                  (main)
  app-tools, jobs, lan-monitor, final-geometry, toolpath-modifiers, export                   (main/post + UI)
mods.default.json   tracked template: enabled list (empty) + default settings
mods.json           per-machine copy (git-ignored), created from the template on first run, edited by the Enable/disable mods window and settings forms
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
| `mods-menu` | ui | App-bar button, status panel and the Enable/disable mods window (toolbar order, what is loaded) |
| `appearance` | main + ui | Theme (light / dark, follow the OS) and UI scale (zoom, `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, compact density) |
| `view` | ui | 3D view: isometric projection with camera presets, and toolpath colouring by depth or operation with hover highlight |
| `bed-size` | ui | The machine travel and 3D platform size the app assumes, instead of its built-in 238 x 200 x 123 mm (needs `--bed-size`) |
| `app-tools` | main + ui | Log and user-data folders, CAM service status and API docs, developer shortcuts (`Ctrl+Shift+M/R/L`, `F12`) |
| `jobs` | main + ui | Job lifecycle: desktop toast and webhook when a run finishes, alarms or pauses; run history with CSV export; the on-screen status pill |
| `jog` | ui | Keyboard (arrows / PgUp / PgDn, Escape stops) and game-controller jogging over one guarded jog engine |
| `work-zero` | ui | Work offsets (G54-G59, set zero here, named machine positions) and the touch-plate Z probing wizard |
| `overrides` | ui | Feed and spindle override percentages using the machine's own `0xCx` / `0xDx` commands, with the live readout |
| `device-macros` | ui | User-defined G-code / command macro buttons with an in-app editor and confirmations |
| `tool-change` | post + ui | Safe retract with spindle and coolant off before every tool change, plus a dialog naming the new tool with Resume when the machine holds |
| `lan-monitor` | main + ui | Read-only status page on the local network with progress, ETA and the latest camera frame |
| `machine-state` | main | Shared machine status, positions, WCS, feed / spindle, progress and ETA (`machine:state`) for the other mods |
| `timelapse` | main | Saves camera frames to `data/timelapse/<job>` every N seconds while a job runs |
| `tools` | ui | Tool library export / import as JSON, resolving id and slot clashes |
| `feeds-speeds` | ui | Chip-load feeds and speeds calculator per material, against the tool library, with favourites |
| `cycles` | ui | Cycle generators: thread milling, helical hole milling and spoilboard surfacing, with preview, validation and export |
| `gcode-lab` | ui | Drop any G-code file: stats, post-processor preview, validate, time estimate, export via the chain |
| `cutter` | ui | Rebuilds the preview's cutter model per toolpath from the tool library (flat, ball, taper / V, drill) |
| `final-geometry` | main + ui | Runs the material simulation to the end and compares the machined stock with the model: rest material, overcuts, volumes, STL export (needs `--stock-sim`) |
| `toolpath-modifiers` | main + ui | Runs chosen post-processors as the CAM generates each toolpath, so the Preview tab and the saved project carry the result |
| `export` | post + main + ui | Everything around an export: save-dialog name template and folder, a stats report with depth / rapid / envelope checks, and an extra copy to a folder |
| `feed-scale` | post | Scales and clamps `F` and `S` words in the exported program (no-op at factor 1) |
| `arc-fit` | post | Runs the bundled ArcWelder on every export: G1 chains become G2/G3 arcs |
| `program-header` | post | Comment block after the app header: file, date, lines, tools, feed / spindle range, XYZ bounds |
| `safe-shutdown` | post | Inserts `M5` / `M9` before `M30` when the spindle or coolant were left on; appends `M30` if missing |
| `peck-drill` | post | Deep straight plunges become peck cycles with chip-clearing retracts |
| `gcode-format` | post | Strips comments / blank lines and adds `N` line numbers, each switchable (both off by default) |
| `tool-split` | post | One extra program file per tool section next to every multi-tool export, each with preamble and safe footer |
| `project-backup` | main | Timestamped copies of every saved project zip in `data/backups`, newest N kept |

All of these start switched off; enable them from MODS ▸ Enable/disable mods. Settings changes apply after "Reload
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
settings helpers), either imperatively (`mods/view`, `mods/cutter`) or in React/TSX through
`usermodUI.react`, which bundles React 19 with components and hooks (`mods/mods-menu`, `mods/gcode-lab`,
`mods/device-macros` are the references; no per-mod bundler, TSX compiles to one injected script). See
[docs/mod-api.md](docs/mod-api.md) for the API, [docs/architecture.md](docs/architecture.md) for how the
app is put together and why the installer repacks the archive, and
[docs/launch-options.md](docs/launch-options.md) for environment variables, switches, ports and helper
executables (including `ENABLE_DOCS=1` for the CAM service's Swagger UI).