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

The menu offers **Install / re-install**, **Select mods**, **Build only** and **Uninstall**. Under the
hood the installer builds the workspace, extracts `resources\app.asar` into `build\app`, applies three
marker-based patches, repacks to `build\app.asar`, backs up the original as `resources\app.asar.orig`,
and copies the patched archive into place. Nest Studio must be closed for the copy.

Non-interactive equivalents:

| Command | Purpose |
| --- | --- |
| `pnpm run install:app -- --install` | install, or re-install after an app update (no-op if current) |
| `pnpm run install:app -- --install --force` | rebuild even if current |
| `pnpm run build:asar` | build `build\app.asar` without touching the install (no admin) |
| `pnpm run mods` | choose enabled mods (writes `mods.json`) |
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
mods/
  feed-override, program-header, safe-shutdown, strip-comments, line-numbers, export-copy   (post-processors)
  mods-menu, gcode-lab, dev-shortcuts                                                       (UI)
  app-tools                                                                                (main + UI)
mods.json      disabled list + per-mod settings (edited by "Select mods")
docs/          launch-options.md, architecture.md, mod-api.md
build/, data/, usermod.log, **/dist   generated, git-ignored
```

Each mod is a package whose `package.json` carries a `usermod` manifest:

```json
"usermod": { "name": "program-header", "postprocessor": "dist/index.js", "order": 20, "description": "..." }
```

Keys: `postprocessor`, `ui`, `main` (entry files, any combination), `order` (load/run order, default 100),
`name`, `description`. The loader discovers every `mods/*/package.json` with a manifest at startup.

## Bundled mods

| Mod | Kind | What it does |
| --- | --- | --- |
| `program-header` | post | Comment block after the app header: file, date, lines, tools, feed/spindle range, XYZ bounds |
| `safe-shutdown` | post | Inserts `M5`/`M9` before `M30` when spindle/coolant were left on; appends `M30` if missing |
| `feed-override` | post | Scale/clamp `F` and `S` words (no-op at factor 1) |
| `export-copy` | post | Also writes each export to a folder (USB stick, network share) once `targetDir` is set |
| `strip-comments` | post (off) | Removes comments and blank lines, keeping the app header |
| `line-numbers` | post (off) | Adds `N` line numbers |
| `mods-menu` | ui | App-bar button and panel: status, mod actions, reload post-processors / UI |
| `gcode-lab` | ui | Drop any G-code file: stats, post-processor preview, validate, time estimate, export via chain |
| `app-tools` | ui + main | Open app logs / user data / usermod.log, CAM service status, open API docs |
| `dev-shortcuts` | ui | `Ctrl+Shift+M` panel, `Ctrl+Shift+R` reload UI, `Ctrl+Shift+L` open log |

Post-processor and `mods.json` changes apply after "Reload post-processors" in the MODS panel; UI and
main mods need an app restart (or `Ctrl+Shift+R` for UI mods).

## Development

```powershell
pnpm run build      # tsc for every package and mod
pnpm run watch      # loader + all mods in watch mode (concurrently)
pnpm test           # build, then run the loader harness under a stubbed Electron
```

Writing a mod: copy one of the `mods/*` packages, edit `src/index.ts` against the `Usermod.*` types,
add the `usermod` manifest, run `pnpm install` (links the types package) and `pnpm run build`. See
[docs/mod-api.md](docs/mod-api.md) for the API, [docs/architecture.md](docs/architecture.md) for how the
app is put together and why the installer repacks the archive, and
[docs/launch-options.md](docs/launch-options.md) for environment variables, switches, ports and helper
executables (including `ENABLE_DOCS=1` for the CAM service's Swagger UI).
