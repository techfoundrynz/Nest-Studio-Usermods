# Nest Studio architecture notes

Findings from an investigation of Nest Studio 1.1.0 for Windows (Nestworks / Elephant Robotics desktop
CNC software). These notes explain why the user-mod system is shaped the way it is.

## Processes

```
nest-studio.exe (Electron 39, Chromium 142, Node 22)
 ├─ main process      out/main/index.js (readable Rollup output, ~3200 lines)
 │    ├─ spawns       resources\server\3Axis\Nest Studio Service.exe   (CAM, HTTP 127.0.0.1:9630)
 │    ├─ spawns       gcode_validator_cli.exe / ArcWelder.exe on demand
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
change shipped JS is to rewrite `app.asar`. `tools/asar-tool.js` does that without dependencies by
reusing the original header: file layout, `unpacked` flags and `app.asar.unpacked` stay identical, only
the three patched files change size/offset. Fuse `EnableEmbeddedAsarIntegrityValidation` is off, so the
dropped integrity blocks are not checked. The Windows executable's Authenticode signature does not
cover the asar.

## Hook points used by the loader

| Channel | Payload | Used for |
| --- | --- | --- |
| `store:write-file(filePath, text)` | every text file the renderer saves | post-processors on `.nc .gcode .tap .ngc .cnc` (stage `export`) |
| `device:send-gcode(options)` / `device:sync-gcode-to-small-screen(options)` | `{ fileName, gcode, gcodeRunTime, limitResult }` | post-processors stage `send` |

The renderer writes exports through `window.api.store.writeFile(dialogPath, gcode)`; the main-process
path sandbox only allows user data, temp, downloads and dialog-picked paths. Internal scratch files
under user data are skipped by the loader unless a post-processor sets `includeInternal`.

## Renderer anchors

The app bar (`AppBar` in `FullApp-*.js`) exposes stable test ids:
`prepare-app-bar`, `prepare-app-bar-brand`, `prepare-app-bar-home`, `prepare-app-bar-settings`,
`prepare-app-bar-window-controls`, `prepare-window-minimize|maximize|close`. Routes are hash based:
`#/home`, `#/project`, `#/preview`, `#/device`. Icons are inline SVG React components (default 18 px)
inside 36 px buttons.

## Update behaviour

`electron-updater` with a generic provider downloads a full NSIS installer, which removes the whole
install directory before installing. Anything under `Program Files` is lost on update; this repo lives
elsewhere and `tools/install.ps1` re-applies the patch to the new `app.asar` in a few seconds.
