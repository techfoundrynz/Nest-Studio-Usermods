import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export type Dispatch = (action: string, args: Record<string, unknown>) => Promise<unknown>;
const project = { projectId: z.string().min(1).max(200).describe("Exact project ID from list_projects; open its Prepare page first.") };
export function createMcp(dispatch: Dispatch): McpServer {
  const mcp = new McpServer({ name: "nest-studio", version: "0.3.0" });
  function tool(name: string, description: string, inputSchema: Record<string, z.ZodType>, readOnly = false): void {
    mcp.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false } }, async (args) => {
      try {
        if ((name === "validate_programs" || name === "export_nc_file") && args.programId && !args.setupId) throw new Error("programId requires setupId");
        if (name === "preview_toolpaths" && args.operationId && !args.modelId) throw new Error("operationId requires modelId");
        if (name === "simplify_model" && args.stage === "preview" && args.percent === undefined) throw new Error("Simplification preview requires percent");
        if (name === "manage_tool_slots") {
          if (args.action === "reorder") {
            const ids = args.toolIds as (string | null)[] | undefined;
            if (!ids || new Set(ids.filter(id => id !== null)).size !== ids.filter(id => id !== null).length) throw new Error("Supply five slots with unique tool IDs");
          } else if (!args.toolId || (args.action === "assign" && args.slotNum === undefined)) throw new Error("toolId and assign slotNum are required");
        }
        const result = await dispatch(name, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Action failed" }] };
      }
    });
  }
  tool("get_status", "Nest Studio version, connection and optional normalized machine/job status. Does not connect or move the machine.", {}, true);
  tool("get_machining_capabilities", "List supported native machining axes, automatic strategies, custom operation types, rotary base/cutoff support and limits.", {}, true);
  tool("open_file", "Import a local STEP/STP/STL model (up to 32 MiB) through the native importer without a picker. Choose 3Axis or 4Axis. Adds to a matching active project unless newProject=true. Native 4-axis projects accept one model. Wait for importRepair validation metadata before repair_model. Does not generate or machine. Project ZIP opening is unsupported.", { filePath: z.string().min(1).max(4096), axis: z.enum(["3Axis", "4Axis"]).default("3Axis"), newProject: z.boolean().default(false) });
  tool("list_projects", "List open project IDs and names from the live project session (Prepare page required).", {}, true);
  tool("get_project", "Read the current project document, including stock, setups, operations and toolpath metadata. Excludes model binary data.", project, true);
  tool("save_project_copy", "Save a complete native project ZIP copy to a new absolute .zip path without a file picker. Includes model data and toolpaths. Refuses overwrites. The open project keeps its current save/dirty state.", { ...project, filePath: z.string().min(1).max(4096) });
  tool("get_cam_state", "Read native planning/generation state, toolpath availability, fixture configuration, live model bounds, process tree and drafts. Open the active project's Prepare page first.", project, true);
  const axes = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
  tool("transform_model", "Set a model's position in mm and/or Euler XYZ rotation in degrees, before planning. Uses the native transform command, invalidates derived data, synchronizes the flip setup and reloads the scene. Does not change scale. Inspect get_cam_state bounds afterwards.", { ...project, modelId: z.string().min(1).max(200), position: axes.optional(), rotationDeg: axes.optional() });
  tool("repair_model", "Run the native reversible mesh repair before planning/generation. Can alter geometry; inspect the result and importRepair state before machining. Does not overwrite the source STEP file.", { ...project, modelId: z.string().min(1).max(200) });
  tool("generate_planned_toolpaths", "Generate from the native plan/drafts after generate_toolpaths. For 3-axis, replaces selected sides and waits for completion. For 4-axis, starts the native rotary relief/base/cutoff controller and returns workflow_requested; poll get_cam_state. Native stock, tool and rotary clearance checks remain active. Does not send anything to a machine.", { ...project, sides: z.array(z.enum(["top", "bottom"])).min(1).max(2).default(["top", "bottom"]) });
  tool("rename_project", "Rename an open project through the native project command gateway. Marks it unsaved.", { ...project, name: z.string().trim().min(1).max(80).regex(/^[^<>:"/\\|?*\x00-\x1f]+$/) });
  tool("set_stock_dimensions", "Change stock dimensions in mm through native stock adaptation and parameter-edit checks. A native confirmation may need attention; read get_project to verify the result.", { ...project, width: z.number().positive().max(10000), length: z.number().positive().max(10000), thickness: z.number().positive().max(10000) });
  tool("configure_stock", "Change native material type and square/round stock shape, or select a native fixture. Dimensions use Nest Studio's native width/length/thickness fields from get_project. 3-axis stock must be square; 4-axis requires fourth-axis fixture. Native adaptation/checks apply; read back the result.", { ...project, materialType: z.string().min(1).max(100).optional(), shape: z.enum(["square", "round"]).optional(), fixture: z.enum(["side-clamp-square", "plate-clamp", "side-clamp", "electric-vise", "low-profile-vise", "fourth-axis"]).optional() });
  const toolOverride = z.object({ toolId: z.string().min(1), spindleSpeed: z.number().positive().max(100000).optional(), freeRate: z.number().positive().max(100000).optional(), plungeRate: z.number().positive().max(100000).optional(), depthPerPass: z.number().positive().max(100).optional(), stepOver: z.number().positive().max(100).optional(), withdrawalDistance: z.number().nonnegative().max(100).optional() });
  const mode4 = z.object({ base: z.object({ enabled: z.boolean(), shape: z.enum(["box", "cylinder"]), length: z.number().positive().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(), diameter: z.number().positive().optional() }), smartCutoff: z.object({ enabled: z.boolean(), remainingThickness: z.number().positive().optional() }) });
  const supportSetting = z.object({ checkTab: z.boolean().optional(), tabNum: z.number().int().min(1).max(100).optional(), tabLength: z.number().positive().max(1000).optional(), tabHigh: z.number().positive().max(100).optional(), checkReserveTab: z.boolean().optional(), reserveTabDepth: z.number().nonnegative().max(100).optional(), checkCutTab: z.boolean().optional(), cutTabDepth: z.number().positive().max(100).optional(), frontMachiningDepth: z.number().nonnegative().max(1000).optional(), backMachiningDepth: z.number().nonnegative().max(1000).optional() });
  tool("configure_toolpath_plan", "Configure native smart-milling drafts: mounted tools, feeds/speeds, carving, 3-axis retaining tabs/reserve/cut depths, or rotary base/cutoff. Support changes apply to all faces of the selected model; omit setupId when changing supportSetting. Changing tab dimensions/count resets custom tab placement to automatic layout. Read get_cam_state afterwards.", { ...project, setupId: z.string().min(1).optional(), modelId: z.string().min(1).optional(), toolIds: z.array(z.string().min(1)).min(1).max(32).optional(), toolOverrides: z.array(toolOverride).max(32).optional(), carving: z.boolean().optional(), supportSetting: supportSetting.optional(), fourAxisMachiningMode: mode4.optional() });
  const identity = { ...project, setupId: z.string().min(1).max(200), modelId: z.string().min(1).max(200) };
  tool("begin_operation", "Open a native custom-operation editor for a 3-axis standard project. Choose contour, pocket, drilling, chamfer or thread; optional operationId edits an existing custom operation. Poll get_operation_editor until ready. Native rotary projects use smart relief/base/cutoff instead.", { ...identity, operationType: z.enum(["contour", "pocket", "drilling", "chamfer", "thread"]), operationId: z.string().min(1).max(200).optional() });
  tool("get_operation_editor", "Read the native operation-editor request, phase, configuration and available parameter fields.", project, true);
  tool("get_operation_geometry", "Load the native outline/feature data for the current operation editor without picking geometry on screen.", project, true);
  tool("configure_operation", "Update the current native custom-operation configuration. Cut-setting keys must already exist in the native configuration; changing toolId refreshes native recommendations. Geometry uses the native outline-selection shape returned by the editor/geometry tools. Does not start generation.", { ...project, toolId: z.string().min(1).optional(), cutSetting: z.record(z.string(), z.union([z.number().finite(), z.boolean(), z.string().max(500), z.array(z.number().finite()).max(20)])).optional(), geometry: z.record(z.string(), z.unknown()).optional() });
  tool("commit_operation", "Request native generation/commit of the current custom operation. Keeps native geometry, tool, stale-state and selection checks; does not auto-confirm an invalid selection. Returns workflow_requested; poll native state/results.", project);
  tool("cancel_operation", "Close the current custom-operation editor without committing its draft.", project);
  tool("delete_operation", "Delete a native custom operation through the undoable command gateway.", { ...identity, operationId: z.string().min(1).max(200) });
  tool("list_tools", "Read the authoritative CAM tool library, including versions and magazine slots.", {}, true);
  tool("save_tool", "Create or update a CAM library tool through the native controller. New tools are unloaded; replacements preserve their existing slot. For updates supply the version returned by list_tools.", { tool: z.object({ id: z.string().max(200), name: z.string().min(1).max(200), type: z.string().min(1).max(100), diameter: z.number().positive().max(1000) }).passthrough(), replace: z.boolean().default(false), expectedVersion: z.number().int().nonnegative().optional() });
  tool("generate_toolpaths", "Request the native Generate workflow for the active project. Returns workflow_requested, not completion. Review any native regeneration/planning dialogs, then inspect get_project for results.", project);
  tool("cancel_toolpath_plan", "Close/cancel the current native smart-planning draft without changing generated programs. Cancels planning preparation, but refuses to interrupt active toolpath generation.", project);
  tool("export_toolpaths", "Open the native G-code export/save workflow for one setup. Choose setupId from get_project.saveCoordsSystemList. The user chooses the destination. Returns workflow_requested, not proof that a file was saved. Native export post-processors remain active.", { ...project, setupId: z.string().min(1).max(200) });
  tool("start_machining", "Request the native machining workflow, including toolpath inspection, device readiness and centering. Returns workflow_requested; native prompts must be completed in Nest Studio.", project);
  tool("connect_machine", "Connect over the LAN using Nest Studio's native device API. Does not start machining.", { ipAddress: z.ipv4(), codeValue: z.string().regex(/^\d{6}$/) });
  tool("disconnect_machine", "Disconnect the current machine using the native API.", {});
  tool("send_machine_command", "Send one exact CNC/controller command through the native text channel after a local Nest Studio approval dialog. Can move axes or start the spindle. No automatic retry; a timeout leaves the outcome unknown. Requires a connected machine.", { command: z.string().min(1).max(512).regex(/^[^\r\n\x00]+$/) });
  tool("validate_gcode", "Run Nest Studio's native G-code validation without sending it to a machine.", { gcode: z.string().max(512 * 1024) }, true);
  tool("estimate_gcode_time", "Estimate G-code motion time using the native service without machine execution.", { gcode: z.string().max(512 * 1024) }, true);
  tool("list_jobs", "Read job history when the jobs mod is enabled; reports unavailable otherwise.", {}, true);
  tool("open_project", "Open a native project ZIP from an absolute local path without a file picker (up to 64 MiB). Native duplicate-project and import checks apply.", { filePath: z.string().min(1).max(4096) });
  tool("activate_project", "Switch to an existing project tab. Wait for its Prepare gateway before making project calls.", project);
  tool("close_project", "Close a project using the native unsaved-changes prompt. Never silently discards work; returns closed or not_closed after the prompt.", project);
  tool("save_project", "Save the active project through native persistence, dirty tracking and recent files. First save/saveAs may open a native destination dialog. Use save_project_copy for a dialog-free separate archive.", { ...project, saveAs: z.boolean().default(false) });
  tool("list_programs", "List exportable generated program IDs by setup, with tools and operation IDs. Excludes ignored/non-exportable results; no G-code payload.", project, true);
  const selection = { ...project, setupId: z.string().min(1).max(200).optional(), programId: z.string().min(1).max(200).optional() };
  tool("validate_programs", "Validate complete native export content and estimate time by project/setup/program ID without the raw-text limit or machine execution. programId requires setupId. Validates native output before usermod export postprocessors.", selection, true);
  tool("inspect_toolpaths", "Run native per-face material/overcut inspection and return reports without geometry buffers. Unsupported/incomplete reports are not a machining safety certificate. Does not start machining.", { ...project, setupId: z.string().min(1).max(200).optional(), retry: z.boolean().default(false) }, true);
  tool("export_nc_file", "Export native G-code to a new absolute path without a picker; preserves rotary conversion and usermod export postprocessors. Choose .nc for one setup/program; whole multi-face projects require .zip. Refuses overwrites.", { ...selection, filePath: z.string().min(1).max(4096) });
  tool("manage_tool_slots", "Change the app's tool-library magazine assignments or delete an unassigned tool. This updates software inventory only; it does not physically install a cutter. Supply expectedVersions for EVERY library tool from list_tools. reorder requires five distinct tool IDs/null entries.", { action: z.enum(["assign", "unassign", "reorder", "delete"]), toolId: z.string().min(1).max(200).optional(), slotNum: z.number().int().min(1).max(5).optional(), toolIds: z.array(z.string().min(1).max(200).nullable()).length(5).optional(), expectedVersions: z.record(z.string(), z.number().int().positive()) });
  tool("preview_toolpaths", "Open native simulation preview for a generated setup or operation. operationId requires modelId. Preview navigation can leave Prepare; activate_project to return.", { ...project, setupId: z.string().min(1).max(200), modelId: z.string().min(1).max(200).optional(), operationId: z.string().min(1).max(200).optional() });
  tool("set_operation_enabled", "Include/exclude a generated operation using the native ignored-operation controller and undo history. Excluded operations are omitted from native export/machining.", { ...identity, operationId: z.string().min(1).max(200), enabled: z.boolean() });
  tool("set_operation_visibility", "Show/hide a generated operation in the native viewport. Visibility does not exclude an operation from export/machining; use set_operation_enabled for that.", { ...identity, operationId: z.string().min(1).max(200), visible: z.boolean() });
  tool("set_work_origin", "Set native 3-axis work origin before generating toolpaths. Refuses changes while the native origin control is locked.", { ...project, origin: z.enum(["center", "bottomLeft"]) });
  tool("get_model_analysis", "Read native feature/machinability analysis and its current running model. Missing/pending analysis is not a successful inspection.", project, true);
  tool("get_model_edit_state", "Read native simplification session state and undo/redo availability.", project, true);
  tool("scale_model", "Uniformly scale a model by a positive factor using native geometry editing and history, before toolpath generation. Changes part dimensions; inspect bounds afterwards.", { ...project, modelId: z.string().min(1).max(200), factor: z.number().positive().max(1000) });
  tool("remove_model", "Remove a model through native removal, scene synchronization and undo history, before toolpath generation.", { ...project, modelId: z.string().min(1).max(200) });
  tool("undo_repair", "Undo native mesh repair through the app's repair history, before generating toolpaths.", { ...project, modelId: z.string().min(1).max(200) });
  tool("model_history", "Apply one native model undo/redo step; inspect project, geometry and toolpath validity afterwards.", { ...project, direction: z.enum(["undo", "redo"]) });
  tool("simplify_model", "Native staged mesh simplification, when enabled: open, poll get_model_edit_state until sourceReady, preview percent (native reduction setting), poll until finished, then commit or cancel. Preview changes geometry; cancel restores the opening snapshot.", { ...project, modelId: z.string().min(1).max(200), stage: z.enum(["open", "preview", "commit", "cancel"]), percent: z.number().min(0).max(100).optional() });
  return mcp;
}

/** Stateless Streamable HTTP: one SDK instance per request; no unbounded session registry. */
export function createHttpServer(token: string, dispatch: Dispatch): http.Server {
  if (!token || token.length < 32) throw new Error("MCP access token must contain at least 32 characters");
  let active = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reject = (status: number, message: string): void => { res.writeHead(status, { "Content-Type": "text/plain" }).end(message); };
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return reject(403, "Invalid Host");
    if (req.headers.origin) {
      try { const origin = new URL(req.headers.origin); if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost'].includes(origin.hostname)) return reject(403, "Invalid Origin"); }
      catch { return reject(403, "Invalid Origin"); }
    }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reject(401, "Bearer token required");
    if (req.url !== "/mcp") return reject(404, "Not found");
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return reject(405, "Use POST"); }
    if (active >= 8) return reject(503, "MCP server busy");
    active++;
    const mcp = createMcp(dispatch);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 });
    const cleanup = (): void => { void mcp.close().catch(() => undefined); };
    res.once("close", cleanup);
    try { await mcp.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) reject(500, "MCP request failed"); else res.end(); }
    finally { active--; }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 180000;
  return server;
}
