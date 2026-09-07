# NestStudio_UserMods

A user-mod loader for [Nest Studio](https://www.nestworks.ai) (Nestworks desktop CNC software, Electron
+ Python CAM service) plus a set of bundled mods, written in TypeScript and organised as a pnpm
workspace. It adds:

- **Post-processors**: typed transforms applied to every G-code file the app exports (and, optionally,
  to G-code sent to the machine).
- **UI mods**: scripts injected into the app's renderer, with a **MODS** button in the app bar.
- **Main mods**: main-process extensions with full Node access, exposed to UI mods over IPC.
- **Update-proof install**: an interactive installer rebuilds `app.asar` and can be re-run after every
  app update.

Tested against Nest Studio 1.1.0 (Electron 39.8.10) on Windows 11. Modifying the app may be against the
vendor's terms of use; the `send` stage changes what reaches a real machine. Use with care.
Licensed under the GPL-3.0 (see `LICENSE`).

## Install

Requirements: Node.js 20+, pnpm 10+ (`corepack enable` or `npm i -g pnpm`), Nest Studio installed in
`C:\Program Files\nest-studio` (pass `--install-root=<dir>` otherwise).

```powershell
git clone <this repo> C:\Repos\NestStudio_UserMods
cd C:\Repos\NestStudio_UserMods
pnpm install
pnpm run install:app          # interactive menu; the final copy step needs an elevated terminal
```

The menu offers **Install / re-install**, **Build only**, **Enable / disable mods** and **Uninstall**.
Under the hood the installer builds the workspace, extracts `resources\app.asar` into `build\app`,
applies marker-based patches, verifies the patched main script still parses, repacks to
`build\app.asar`, backs up the original as `resources\app.asar.orig`, and copies the patched archive
into place. Nest Studio must be closed for the copy.

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
| `pnpm run install:app -- --install --devtools` | build option: re-enable Chromium DevTools (the app ships with them off); `F12` or MODS ▸ Developer toggles them |
| `pnpm run install:app -- --install --cam-docs` | build option: start the CAM service with `ENABLE_DOCS=1` so Swagger is at `127.0.0.1:9630/docs` |

Build options are baked into the patched archive. The interactive install asks for them; `--no-devtools` /
`--no-cam-docs` turn them off again. The MODS panel shows which ones the installed build carries.
| `pnpm run build:asar` | build `build\app.asar` without touching the install (no admin) |
| `pnpm run mods` | CLI fallback for enabling/disabling mods (writes `mods.json`) |
| `pnpm run uninstall:app` | restore `app.asar.orig` |
| `tools\install.ps1 [args]` | thin PowerShell wrapper for elevated shells |

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
  ui-kit/      @neststudio-usermods/ui-kit     window.usermodUI: toolbar buttons, popovers, modals, forms, settings forms
mods/
  feed-override, arc-fit, tool-change-guard, program-header, safe-shutdown, export-copy,
  strip-comments, line-numbers                                                              (post-processors)
  mods-menu, dark-mode, gcode-lab, dev-shortcuts, iso-view, status-hud, device-macros,
  tool-change-assistant, keyboard-jog                                                       (UI)
  machine-state, camera-timelapse, project-backup, export-filename                          (main)
  app-tools, job-notifier, ui-scale, export-report                                          (main/post + UI)
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
| `job-notifier` | main + ui | Windows toast (and optional webhook) when a machine job finishes, alarms or pauses; status panel in the MODS menu |
| `export-report` | post + ui | JSON stats report per export (bounds, tools, feeds) in `data/reports`; "Last export report…" in the menu |
| `iso-view` | ui | Toolbar toggle between perspective and an isometric-style view of the 3D scene; right-click for Top/Front/Right/Iso/Reset |
| `machine-state` | main | Shared machine status / progress / ETA (`machine:state`) for other mods; optional console log to `data/console` |
| `status-hud` | ui | Always-visible status pill with progress bar and ETA; click for details |
| `device-macros` | ui | Toolbar button with user-defined G-code / command macros (with confirmation) |
| `tool-change-assistant` | ui | When the machine holds at a tool change, names the tool from the library and offers Resume |
| `camera-timelapse` | main | Saves camera frames to `data/timelapse/<job>` every N seconds while a job runs |
| `project-backup` | main | Timestamped copies of every saved project zip in `data/backups`, newest N kept |
| `export-filename` | main | Pre-fills the export dialog from a template (`{name} {project} {date} {time}`) and default folder |
| `keyboard-jog` | ui | Hold arrows / PgUp / PgDn on the Device tab to jog (GRBL `$J`), release to stop |
| `strip-comments` | post (off) | Removes comments and blank lines, keeping the app header |
| `line-numbers` | post (off) | Adds `N` line numbers |
| `mods-menu` | ui | App-bar button and panel: status, mod actions, reload post-processors / UI |
| `dark-mode` | ui | Sun/moon toolbar button that switches Nest Studio's built-in dark theme; optional follow-OS setting |
| `ui-scale` | ui + main | UI zoom (`Ctrl+=` / `Ctrl+-` / `Ctrl+0`, remembered) and a compact density mode that tightens the app's spacing tokens |
| `gcode-lab` | ui | Drop any G-code file: stats, post-processor preview, validate, time estimate, export via chain |
| `app-tools` | ui + main | Open app logs / user data / usermod.log, CAM service status, open API docs |
| `dev-shortcuts` | ui | `Ctrl+Shift+M` panel, `Ctrl+Shift+R` reload UI, `Ctrl+Shift+L` open log, `F12` DevTools |

All of these start switched off; enable them from MODS ▸ Mods…. Settings changes apply after "Reload
post-processors" in the MODS panel; UI mods after a UI reload (`Ctrl+Shift+R`), main mods at app start.

## Development

```powershell
pnpm run build      # tsc for every package and mod
pnpm run watch      # loader + all mods in watch mode (concurrently)
pnpm test           # build, then run the loader harness under a stubbed Electron
```

Writing a mod: copy one of the `mods/*` packages, edit `src/index.ts` against the `Usermod.*` types,
add the `usermod` manifest, run `pnpm install` (links the types package) and `pnpm run build`. UI mods
build on `window.usermodUI` (toolbar buttons next to the Settings gear, popovers, modals, form and
settings helpers); `mods/mods-menu` and `mods/dark-mode` are the reference examples. See
[docs/mod-api.md](docs/mod-api.md) for the API, [docs/architecture.md](docs/architecture.md) for how the
app is put together and why the installer repacks the archive, and
[docs/launch-options.md](docs/launch-options.md) for environment variables, switches, ports and helper
executables (including `ENABLE_DOCS=1` for the CAM service's Swagger UI).
