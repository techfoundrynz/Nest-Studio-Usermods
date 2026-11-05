# Nest Studio architecture notes

Findings from Nest Studio 1.1.0, updated for the 2.0.0 loader migration for Windows (Nestworks / Elephant Robotics desktop
CNC software). These notes explain why the user-mod system is shaped the way it is.

## Processes

```
nest-studio.exe (Electron 39, Chromium 142, Node 22)
 ├─ main process      out/main/index.js (readable Rollup output, ~3200 lines)
 │    ├─ spawns       resources\server\3Axis\Nest Studio Service.exe   (CAM, HTTP 127.0.0.1:9630)
 │    ├─ spawns       gcode_validator_cli.exe on demand
 │    ├─ gRPC client  to the machine (port 65002), UDP discovery (65003), serialport
 │    └─ IPC          ~55 channels registered via registerInvokeHandler / registerSendHandler
 ├─ preload           out/preload/index.js  -> window.api (contextIsolation + sandbox on)
 └─ renderer          out/renderer/*  React + antd + three.js, Vite build, minified, no source maps
```

The CAM service is a Nuitka-compiled Flask app served by waitress. Its Python is not editable; the
`.pyd` modules under `cam_core/` are the geometry engines (OpenCASCADE, Open3D, Embree, ONNX).

## What is and is not moddable

| Layer | Moddable? | How |
| --- | --- | --- |
| Main process | Yes, easily | Readable JS. Hook `ipcMain.handle` registrations, add IPC, spawn helpers. This is where the loader lives. |
| Preload | Yes, by inlining | Sandboxed: only `require("electron")` works, so the bridge is spliced in as text. |
| Renderer | Yes, with care | CSP `script-src 'self'` (we add `file:`). Inject scripts; anchor on `data-testid` attributes, not hashed class names. |
| CAM service | No source | But the HTTP API is open: 25 endpoints, no auth. Swagger via `ENABLE_DOCS=1`. |
| Machine protocol | Yes | `grpcdata.proto` ships in plaintext. |

## Why repacking

Electron resolves the app in this order for this build: `resources\app.asar`, then
`resources\default_app.asar`. A plain `resources\app` folder is ignored (tested), so the only way to
change shipped JS is to rewrite `app.asar`. `packages/asar` does that without dependencies by reusing
the original header: file layout, `unpacked` flags and `app.asar.unpacked` stay identical, only the
three patched files change size/offset. Fuse `EnableEmbeddedAsarIntegrityValidation` is off, so the
dropped integrity blocks are not checked. The Windows executable's Authenticode signature does not
cover the asar.

## Hook points used by the loader

| Channel | Payload | Used for |
| --- | --- | --- |
| `store:write-file(filePath, text)` | every text file the renderer saves | post-processors on `.nc .gcode .tap .ngc .cnc` (stage `export`) |
| `device:send-gcode(options)` / `device:sync-gcode-to-small-screen(options)` | `{ fileName, gcode, gcodeRunTime, limitResult }` | post-processors stage `send` |

In 2.0, native exports use begin/append/finish binary writes. The installer patches `finishBinaryFileWrite`
after closing its temporary file and before the atomic rename, calling the loader's `processExportFile`.
NC files and every member of G-code-only ZIPs run through the export chain. ZIP directory inspection skips
project saves without expanding them. A processing failure aborts the commit and preserves the old destination.
The text-file hook remains for legacy/internal callers. The native main-process path sandbox still authorizes
all destinations before a write session begins. Internal scratch files
under user data are skipped by the loader unless a post-processor sets `includeInternal`.

## Repository layout and build

pnpm workspace: `packages/*` (types, loader, asar, installer) and `mods/*` (one package per mod, each
with a `usermod` manifest in `package.json`). Everything is TypeScript compiled with plain `tsc`:

- main-process code -> CommonJS (`module: CommonJS`), Node + Electron types
- renderer code -> classic scripts (`module: None`, one IIFE per file), DOM types; shared types are
  ambient declarations so they work without imports

The installer (`packages/installer`, run with `tsx`) builds the workspace, patches three files in the
extracted archive, repacks, and injects `require("<repo>/packages/loader/dist/main.js")` as the first
statement of the app's main script. Mods therefore load straight from the repo at runtime.

## Renderer anchors

The app bar (`AppBar` in `FullApp-*.js`) exposes stable test ids:
`prepare-app-bar`, `prepare-app-bar-brand`, `prepare-app-bar-home`, `prepare-app-bar-settings`,
`prepare-app-bar-window-controls`, `prepare-window-minimize|maximize|close`. Routes are hash based:
`#/home`, `#/project`, `#/preview`, `#/device`. Icons are inline SVG React components (default 18 px)
inside 36 px buttons.

## Update behaviour

`electron-updater` with a generic provider downloads a full NSIS installer, which removes the whole
install directory before installing. Anything under `Program Files` is lost on update; this repo lives
elsewhere and `pnpm run install:app` re-applies the patch to the new `app.asar` in a few seconds.

## Nest Studio 2.0 integration

Toolpath modifiers intercept successful `cam:read-toolpaths` results recursively at explicit `gcode` fields,
and STEP NC text returned by `cam:read-process-tree`. Other process-tree/geometry JSON remains untouched.
Inline custom-operation HTTP responses remain supported; fallback returns a clone of the original response,
never a duplicate generation request. Preview markers prevent the same processor running again at export.

`__usermodTools` is installed alongside the native `ToolLibraryController`; UI mods access it through
`usermodRuntime.tools`. Reads refresh authoritative service state. Writes use native create/update methods,
optimistic versions, native project invalidation and physical slot management. The JSON user store is no
longer authoritative for tool definitions.

Material simulation is enabled by the vendor. `stock-export` performs an isolated CPU height-field calculation
with copied timeline data, separate numbered tools, stock-origin offsets, cancellation and cleanup. It does
not move or replace the active GPU preview. Output is approximate and excludes rotary machining/undercuts.

All mandatory bridge sites and requested optional sites must verify before packing. Installer/preload source
fingerprints invalidate stale staging directories and install stamps after patch changes.
