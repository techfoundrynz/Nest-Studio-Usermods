# Nest Studio MCP plugin

The `mcp-server` mod lets an MCP client interact with the running Nest Studio application. It uses the
official TypeScript MCP SDK and stateless Streamable HTTP at `http://127.0.0.1:9641/mcp`.
It runs inside Nest Studio; closing the app stops the endpoint. No separate server process is needed.
MCP 0.3 exposes 53 tools. Its inspection, file, project-lifecycle and tool-slot gateways require a rebuilt
loader archive; restarting only the plugin does not install those native adapters.

## Setup

1. Build and reinstall the current loader after saving and closing Nest Studio. The installer adds a
   native Prepare gateway and verifies it in the packed archive. This is needed even if a previous
   2.0.1 loader is installed.
2. Start Nest Studio, open MODS → Enable/disable mods, enable **mcp-server**, and save. Allow the UI
   reload so the mod's renderer dispatcher is loaded.
3. Open the **MCP server** toolbar/overflow button and click **Copy client configuration**. Paste the
   configuration into an MCP client supporting HTTP endpoints and custom authorization headers.
4. Open a project's **Prepare** page for project tools. `open_file` accepts `axis: "3Axis"` or
   `axis: "4Axis"` and `newProject: true` to create a separate project. `list_projects` gives IDs; project mutations
   require the requested project to be active there. Tools and device status do not require a project.

The copied configuration has this shape (the real token is filled in locally):

```json
{
  "mcpServers": {
    "nest-studio": {
      "url": "http://127.0.0.1:9641/mcp",
      "headers": { "Authorization": "Bearer <local-token>" }
    }
  }
}
```

Clients use different configuration formats. For example, VS Code uses `servers` with `type: "http"`;
use the same URL and Authorization header. A cloud-hosted client cannot reach this PC's loopback address.
This plugin does not expose a public tunnel or a LAN listener.

The plugin creates `data/mcp-server/access-token` on first activation and reuses it across restarts.
Keep the token/configuration private. To rotate it, close Nest Studio, remove that file, restart, and copy
the new configuration to clients. Tokens and machine pairing codes are not written to plugin logs.
The `mcp-server.port` setting defaults to 9641; changing it requires an app restart. Port conflicts are
shown in the panel. Disabling a main mod takes effect after restarting Nest Studio.

## Available tools

| Tool | Behavior |
| --- | --- |
| `get_status` | Native connection status and app version; includes normalized state if `machine-state` is enabled |
| `open_file` | Import a local STEP/STP/STL model up to 32 MiB without a file picker; choose 3Axis/4Axis and optionally force a new project; returns its project ID after import completes |
| `get_machining_capabilities` | Supported 3/4-axis workflows, custom operation types and native limits |
| `list_projects`, `get_project` | Live open projects and project document; no binary model data |
| `save_project_copy` | Native project ZIP with models and toolpaths to a new absolute path, no file picker; never overwrites; does not mark the open project saved |
| `get_cam_state` | Native planning state, availability checks, fixture, live bounds, tree and drafts |
| `transform_model` | Native position/rotation changes before planning, with flip synchronization and scene reload |
| `repair_model` | Native reversible mesh repair without overwriting the source model |
| `generate_planned_toolpaths` | Generate selected 3-axis faces, or start native rotary relief/base/cutoff generation; poll rotary progress |
| `configure_stock` | Native material/shape and fixture changes; fixture changes are made separately from material/shape |
| `configure_toolpath_plan` | Select mounted tools and override feeds/speeds, carving, and native rotary base/cutoff settings before generation |
| `begin_operation`, `get_operation_editor`, `get_operation_geometry` | Open/create/edit native custom operations and inspect their current configuration and outline geometry |
| `configure_operation`, `commit_operation`, `cancel_operation` | Update native operation parameters/selection, request checked generation, or cancel the draft |
| `delete_operation` | Undoable native custom-operation deletion |
| `rename_project` | Native command commit, dirty tracking and undo history |
| `set_stock_dimensions` | Native stock adaptation/parameter-edit workflow, in mm |
| `list_tools`, `save_tool` | Authoritative CAM library and native controller; version required for replacements; new tools unloaded, replacement slots preserved |
| `generate_toolpaths` | Native Generate workflow and its regeneration/planning dialogs |
| `cancel_toolpath_plan` | Close/cancel smart planning without interrupting active toolpath generation |
| `export_toolpaths` | Native export/save dialog for a setup ID from `saveCoordsSystemList`; existing export post-processors apply |
| `start_machining` | Native machining flow with inspection, readiness checks and centering |
| `connect_machine`, `disconnect_machine` | Native device API; LAN connect takes IP and six-digit access code |
| `send_machine_command` | One exact text command, including G-code; requires a connected machine and a local approval dialog showing the command; rechecks the connection before sending |
| `validate_gcode`, `estimate_gcode_time` | Native services without executing a program; validation supplies current mounted tool slots and their zero-padded aliases |
| `list_jobs` | Job history when `jobs` is enabled; otherwise an explicit unavailable result |
| `open_project` | Open a native project ZIP up to 64 MiB without a picker, retaining native import/duplicate-project decisions |
| `activate_project`, `close_project` | Switch tabs or close with the native unsaved-work prompt; close reports `closed` or `not_closed` |
| `save_project` | Native save, dirty tracking and recent-file update; first save or `saveAs` can require a destination dialog |
| `list_programs` | Exportable setup/program IDs, tools and operation identities without G-code payloads |
| `validate_programs` | Complete native export validation and time estimate by project, setup or program ID; no 512 KiB request limit |
| `inspect_toolpaths` | Run native per-face inspection and return material/overcut risk reports, excluding geometry buffers |
| `export_nc_file` | Native export to a new explicit path, including rotary conversion and enabled export postprocessors; `.nc`/`.gcode`/`.tap` for one file, `.zip` for multiple setups; refuses overwrites |
| `manage_tool_slots` | Native software assignment/unassignment, five-slot reorder and unassigned-tool deletion, guarded by the complete library version snapshot |
| `preview_toolpaths` | Open native setup/operation simulation preview; does not certify safety or control playback |
| `set_operation_enabled` | Include/exclude a generated operation using native ignore state and undo history |
| `set_operation_visibility` | Show/hide generated operation geometry; hidden operations remain included in export unless separately excluded |
| `set_work_origin` | Native 3-axis center/bottom-left origin, before generated paths lock the control |
| `get_model_analysis`, `get_model_edit_state` | Native feature-analysis state, simplification session and model undo/redo availability |
| `scale_model`, `remove_model`, `undo_repair`, `model_history` | Native geometry/model edits and history; geometry edits require planning closed and no generated toolpaths |
| `simplify_model` | Feature-gated native simplification: open, preview a reduction percentage, then commit or cancel; poll model-edit state between stages |

Generation, stock changes, export and machining can return `workflow_requested`. They can open native dialogs
and must not be interpreted as completed generation, saved files, or a running machine. Review the UI and
read the project/status again. Arbitrary document replacement is not exposed. Model
position/rotation and repair are available before planning; inspect bounds and repair status afterwards.
After `generate_toolpaths`, poll `get_cam_state` until `planned` is true, review its plan/drafts, then use
`generate_planned_toolpaths` to complete generation without manually pressing the dialog's Generate button.

## Machining workflows

Raw-text validation requests are limited to 512 KiB. For larger generated programs, use `list_programs`
then `validate_programs` with `projectId`, optionally `setupId` and `programId`. A program ID requires its
setup ID. The adapter streams complete native export content locally, including headers and rotary
conversion, into native validation and time estimation. It does not truncate or split a program.
Validation applies before usermod export postprocessors; it does not validate subsequent processor edits.
Native export/review buffers are limited to 64 MiB per output. Smaller fragments do not establish
whole-program validity. Inspection/validation failures remain errors, never a successful safety result.

For a complete review, generate toolpaths, close planning, inspect `get_cam_state`, run
`inspect_toolpaths`, then `validate_programs`. Review warnings and unsupported/incomplete inspection
results. `export_nc_file` writes the native selected output and runs the same export postprocessor
pipeline as the app, including each NC entry in multi-setup ZIPs. It never sends code to a machine.
Use `setupId` to export one face; omit it for the whole project. Choose a new output filename each time.

`configure_toolpath_plan.supportSetting` accepts retaining-tab count/length/height, reserve and tab-cut
settings, and front/back machining depths. These require a 3-axis plan. Use `modelId` to target one model
and omit `setupId` so support settings stay consistent across its faces. Native fixture depth and tab
height limits are checked before any draft is saved. Changing tab count/dimensions resets existing custom
placement to automatic layout; inspect the new drafts before generating. This does not expose a custom
tab-position editor.

Tool-slot changes update software inventory only. Agents must accurately describe physically installed
cutters. Pass `expectedVersions: { "tool-id": version, ... }` for **every** tool returned by `list_tools`;
a stale or incomplete snapshot is rejected. Reordering takes exactly five tool IDs/nulls. A mounted tool
must be unassigned before deletion. No physical changer command is issued.

For simplification, call `simplify_model` with `stage: "open"`, poll `get_model_edit_state` until
`sourceReady`, request `stage: "preview"` with `percent`, and wait until `simplifying` is false. Inspect
triangle counts and bounds before `stage: "commit"`; `stage: "cancel"` restores the opening geometry.
The percentage is the native reduction setting. Geometry edits are reversible through native history.
`preview_toolpaths` navigates to Preview; call `activate_project` and wait for Prepare before further
project tools. Project close never bypasses the native save/discard/cancel decision.

3-axis smart milling supports both faces and carving. Native custom contour, pocket, drilling, chamfer
and thread operations use `begin_operation` with setup/model IDs. Poll `get_operation_editor` until
`editor.phase` is `ready`; use `get_operation_geometry` for native outlines. Change mounted tool selection,
existing cut-setting fields and current geometry selections through `configure_operation`, then
`commit_operation`. Native stale-geometry and invalid-selection checks remain active. Smart-generated
operations are edited through their plan; custom operations use the native operation editor.

For rotary machining, import with `axis: "4Axis"` (one model per native project), configure square or round
stock and the fourth-axis fixture, then request `generate_toolpaths`. Inspect the native draft and use
`configure_toolpath_plan` to select tools or configure `fourAxisMachiningMode.base` and
`fourAxisMachiningMode.smartCutoff`. Dimensions use the native `machining-zyx` convention; the planner's
returned draft is the reference. Rotary base dimensions, left clearance, stock/fixture limits and mounted
tools are checked before generation. `generate_planned_toolpaths` starts the native rotary controller and
returns `workflow_requested`; poll `get_cam_state` until generation finishes, then inspect the resulting
operations. A successful start is not a claim that the rotary toolpaths completed.

Support follows Nest Studio's native 3D workflows. Native rotary relief/base/cutoff is available; separate
custom contour/pocket/drill/chamfer/thread editing remains a 3-axis standard-project feature. 2D project
ZIP saving and arbitrary five-axis or vendor-unsupported machining modes are not added.

Raw command approval expires after 60 seconds. Mutating MCP calls are serialized by rejecting another
mutation while one is pending. Commands are never retried automatically; a client timeout leaves the
outcome unknown, so inspect the app/machine before issuing the command again.

The listener binds only to IPv4 loopback, requires a bearer token, checks Host and Origin headers, limits
requests to 1 MiB, and caps concurrent HTTP requests. It exposes named tools, not arbitrary JavaScript,
IPC channels, arbitrary file reads, or HTTP/CAM endpoints. `open_file` reads only STEP/STP/STL models;
project ZIP opening is not supported yet. Normalized state and job history are optional;
the plugin does not enable other mods or alter their settings.

## Validation

`pnpm test` includes official-SDK client handshake/tool calls against an isolated HTTP server, credential
and Origin/Host rejection, body-size limits, schema rejection, local approval/concurrent mutation handling,
and native project bridge gates. Tests use fake native APIs and never send commands to a real machine.
The installer verifies the native MCP gateway in the packed archive before installation.

Live verification on Nest Studio 2.0.1 also exercised all five native custom-operation editors,
configuration/cancellation, native outline loading, and a separate rotary test model. The rotary test
generated indexed roughing, rotary finishing and left-cutoff programs with A-axis coordinates, retained
the selected tools/feed override/cylindrical-base settings, closed planning correctly, and reached native
`canMachine: true`. These were CAM-only checks with no machine connection or execution.

Protocol reference: [official MCP TypeScript SDK server guide](https://ts.sdk.modelcontextprotocol.io/server).
