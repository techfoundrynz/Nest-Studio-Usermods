# Nest Studio launch options

Everything below was found by reading the packaged app (`resources\app.asar`, Electron 39.8.10) and the
compiled CAM service (`Nest Studio Service.exe`, Nuitka, Python 3.11) of Nest Studio **1.1.0**. Each
item is marked **verified** (exercised on a real install) or **inferred** (read from code or strings).

## How the pieces start

`nest-studio.exe` is Electron. Its main process spawns `resources\server\3Axis\Nest Studio Service.exe`
with a copy of its own environment, then polls `http://127.0.0.1:9630/api/version` until the service is
healthy. So any environment variable you set before launching the app reaches the CAM service too.

Set variables for one launch from PowerShell:

```powershell
$env:ENABLE_DOCS = '1'; & 'C:\Program Files\nest-studio\nest-studio.exe'
```

## Environment variables

| Variable | Consumer | Effect | Status |
| --- | --- | --- | --- |
| `ENABLE_DOCS=1` | CAM service | Enables Swagger UI at `http://127.0.0.1:9630/docs` and the spec at `/swagger.json`. Default off (`APP_ENV` is hardcoded `PRO`). | verified |
| `NEST_MOD_LOADER=<path>` | user-mod patch in `out/main/index.js` | Overrides which `loader\main.js` the patched app requires. Useful for testing a copy. | verified |
| `NEST_FORCE_UPDATE_CHECK=1` | app main | Allows update checks when the app is not packaged (dev builds only). | inferred |
| `ELECTRON_RENDERER_URL` | app main | Dev-mode renderer URL; only honoured when `is.dev`. Packaged builds ignore it. | inferred |
| `ELECTRON_RUN_AS_NODE=1` | Electron | Runs `nest-studio.exe` as plain Node 22 (fuse `RunAsNode` is enabled). `nest-studio.exe script.js` then executes a script with the bundled runtime. | inferred from fuses |
| `NODE_OPTIONS` | Electron/Node | Honoured (fuse `EnableNodeOptionsEnvironmentVariable` enabled). | inferred from fuses |
| `ELECTRON_ENABLE_LOGGING=1`, `ELECTRON_LOG_FILE=<path>` | Electron | Chromium/Electron internal logging to stderr or a file. | inferred (strings in binary) |
| `FLASK_DEBUG=true` | CAM service | Sets Flask `DEBUG`. Untested; may change error output. | inferred |
| `LOG_LEVEL`, `LOG_FILE_PATH`, `LOG_MAX_SIZE`, `LOG_BACKUP_COUNT`, `ENABLE_LOG` | CAM service | Logging configuration read via `os.environ` in `cam_core.utils.config`. Defaults: `INFO`, `./logs/app.log`. | inferred |
| `SECRET_KEY` | CAM service | Flask secret; default is a dev placeholder. Irrelevant for local use. | inferred |
| `DEV=1` | none | Does **nothing** for docs (tested). Listed to save you the experiment. | verified |

## Command-line arguments

| Argument | Effect | Status |
| --- | --- | --- |
| `neststudio://open?params=<url-encoded JSON>` | Deep link. Route must be `open`; `params` must be a JSON object with a `fileUrl` on an allow-listed host (community model hosts) or a `/NestStudioModel/` path. Also registered as a protocol handler, so a second instance forwards it to the running app and exits silently. | verified (parsing read; forwarding exercised) |
| `--inspect=9229`, `--inspect-brk` | Node inspector for the **main** process (fuse `EnableNodeCliInspectArguments` enabled). Attach with `chrome://inspect`. | inferred from fuses |
| `--remote-debugging-port`, `--remote-debugging-pipe` | Removed by the app at startup (`installDevToolsPolicy`), and DevTools are force-closed when opened. Renderer DevTools need a patched `OPEN_DEV_TOOLS` constant in `out/main/index.js`. | verified in code |
| `--js-flags=--max-old-space-size=8192`, `--enable-gpu-rasterization`, `--ignore-gpu-blocklist` | Appended by the app itself; shown so you know the baseline. Other Chromium switches you pass on the command line are honoured by Electron as usual. | verified in code |

## Ports

| Port | Protocol | Purpose |
| --- | --- | --- |
| 127.0.0.1:9630 | HTTP (waitress + Flask-RESTX) | CAM service. 25 POST endpoints under `/api/`, `GET /api/version`. No auth, CORS `*`. |
| 65002 | gRPC | Machine link (`resources\grpcdata.proto`, service `elephant.cnc.net.v1.GrpcData`). |
| 65003 | UDP broadcast | Machine discovery. Request payload is the literal string `DISCOVERY_REQUEST`. |

## Helper executables

| Executable | Arguments |
| --- | --- |
| `resources\server\gcodeCheck\gcode_validator_cli.exe` | `--rule_file=<rules.json> --gcode_file=<in.nc> --prompt_file=<in.nc> --result_file=<out.json>` (also accepts `--async`, `--max`, `--help`). Rules template lives in `out/main/index.js` (`gcodeRulesTemplate`). |
| `resources\ArcWelder.exe` | `<input.nc> <output.nc> -r=0.01` (arc fitting; the app strips comment lines from the output). |

## Files worth knowing

| Path | What |
| --- | --- |
| `%APPDATA%\Nest Studio\store.json` | User settings, tool library, custom materials, recent projects, **login tokens** (do not share). |
| `%APPDATA%\Nest Studio\logs\{main,render,processing,device-traffic}.log` | electron-log output. |
| `%APPDATA%\Nest Studio\gcode-work\`, `gcode-check\`, `temp\` | Scratch files for time estimate, validation and arc fitting. |
| `%APPDATA%\NestStudio\` | CAM service data dir (`_USER_DATA_DIR`). |
| `%LOCALAPPDATA%\@nestdesktop-updater\` | Downloaded update installers. |
| `resources\app-update.yml` | Update feed (`generic` provider). The code builds its own feed URL from `AUTO_UPDATE_FEED_ROOT`/`prod/win`. |
| `resources\store.json` | Template store used to seed a fresh user store. |

## Electron fuses (as shipped)

`RunAsNode` on, `EnableCookieEncryption` off, `EnableNodeOptionsEnvironmentVariable` on,
`EnableNodeCliInspectArguments` on, `EnableEmbeddedAsarIntegrityValidation` off, `OnlyLoadAppFromAsar`
off, `LoadBrowserProcessSpecificV8Snapshot` off, `GrantFileProtocolExtraPrivileges` on. In practice the
app search order is `app.asar` then `default_app.asar`; a plain `resources\app` directory is not used,
which is why this project repacks the archive.
