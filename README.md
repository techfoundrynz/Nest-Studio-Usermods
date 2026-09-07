# NestStudio_usermods

A user-mod loader for [Nest Studio](https://www.nestworks.ai) (Nestworks desktop CNC software, Electron
+ Python CAM service) plus a set of bundled mods. It adds:

- **Post-processors**: JavaScript transforms applied to every G-code file the app exports (and,
  optionally, to G-code sent to the machine).
- **UI mods**: scripts injected into the app's renderer, with a **MODS** button in the app bar.
- **Main mods**: main-process extensions with full Node access, exposed to UI mods over IPC.
- **Update-proof install**: the installer rebuilds `app.asar` and can be re-run after every app update.

Tested against Nest Studio 1.1.0 (Electron 39.8.10) on Windows 11. Modifying the app may be against
the vendor's terms of use; the `send` stage changes what reaches a real machine. Use with care.

## Install

Requirements: Node.js on `PATH` (any recent version), Nest Studio installed in
`C:\Program Files\nest-studio` (pass `-InstallRoot` otherwise), Nest Studio closed.

```powershell
git clone <this repo> C:\Repos\NestStudio_usermods
# elevated PowerShell:
powershell -ExecutionPolicy Bypass -File C:\Repos\NestStudio_usermods\tools\install.ps1
```

The script extracts `resources\app.asar` into `build\app`, applies three marker-based patches, repacks
to `build\app.asar`, backs up the original as `resources\app.asar.orig`, and copies the patched archive
into place. Only the final copy needs elevation. Start Nest Studio: a puzzle-piece button appears next
to the Settings gear.

| Command | Purpose |
| --- | --- |
| `install.ps1` | install, or re-install after an app update (no-op if already current) |
| `install.ps1 -Force` | rebuild even if current (after editing `loader\preload.js`) |
| `install.ps1 -BuildOnly` | build `build\app.asar` without touching the install (no admin) |
| `install.ps1 -Uninstall` | restore `app.asar.orig` |

The repo folder **is** the live mod directory: the patched app requires `loader\main.js` from wherever
you ran the installer, and UI mods / post-processors load from here at runtime. Keep the folder in
place, or re-run the installer after moving it.

## Layout

```
loader/           main.js (main-process loader), preload.js (bridge, inlined), ui-runtime.js (renderer helpers)
tools/            install.ps1, asar-tool.js (dependency-free extract/pack/list)
postprocessors/   feed-override, program-header, safe-shutdown, z-export-copy, _strip-comments, _line-numbers
ui/               mods-menu, gcode-lab, app-tools, dev-shortcuts
main/             app-tools
mods.json         disabled list + per-mod settings
docs/             launch-options.md, architecture.md, mod-api.md
tests/            harness.js (loader under a stubbed Electron), run-tests.ps1
build/, data/, usermod.log   generated, git-ignored
```

## Bundled mods

| Mod | Kind | What it does |
| --- | --- | --- |
| `program-header` | post | Comment block after the app header: file, date, lines, tools, feed/spindle range, XYZ bounds |
| `safe-shutdown` | post | Inserts `M5`/`M9` before `M30` when spindle/coolant were left on; appends `M30` if missing |
| `feed-override` | post | Scale/clamp `F` and `S` words (no-op at factor 1) |
| `export-copy` | post | Also writes each export to a folder (USB stick, network share) once `targetDir` is set |
| `_strip-comments` | post (off) | Removes comments and blank lines, keeping the app header |
| `_line-numbers` | post (off) | Adds `N` line numbers |
| `mods-menu` | ui | App-bar button and panel: status, actions, reload post-processors / UI |
| `gcode-lab` | ui | Drop any G-code file: stats, post-processor preview, validate, time estimate, export via chain |
| `app-tools` | ui + main | Open app logs / user data / usermod.log, CAM service status, open API docs |
| `dev-shortcuts` | ui | `Ctrl+Shift+M` panel, `Ctrl+Shift+R` reload UI, `Ctrl+Shift+L` open log |

Enable a disabled mod by removing the leading underscore; disable any mod by adding its name to
`mods.json` `disabled`. Post-processors and `mods.json` reload from the panel; UI and main mods need an
app restart (or `Ctrl+Shift+R` for UI mods).

## Writing mods

See [docs/mod-api.md](docs/mod-api.md). For how the app is put together and why the installer works
the way it does, see [docs/architecture.md](docs/architecture.md). Environment variables, command-line
switches, ports and helper executables are in [docs/launch-options.md](docs/launch-options.md)
(including `ENABLE_DOCS=1` for the CAM service's Swagger UI).

## Tests

```powershell
powershell -ExecutionPolicy Bypass -File tests\run-tests.ps1
```

Syntax-checks every script and runs the loader against a stubbed Electron: hook behaviour, bundled
post-processor output, path confinement, IPC surface.
