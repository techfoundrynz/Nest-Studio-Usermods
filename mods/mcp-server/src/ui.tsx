(function mcpServerUi(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "mcp-server", version: "0.2.0" });
  const unwrap = <T,>(r: NestStudio.Result<T>): T => { if (!r.ok) throw Error(r.message ?? r.code ?? "Native request failed"); return r.data; };
  type NativeProjectBridge = { run(action: string, args: Record<string, unknown>): unknown };
  (globalThis as unknown as { __usermodMcpDispatch: unknown }).__usermodMcpDispatch = async (action: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (action) {
      case "get_machining_capabilities": return {
        axes: ["3Axis", "4Axis"], modelFormats: ["step", "stp", "stl"],
        threeAxis: { smartMilling: true, carving: true, flippedSetups: true, customOperations: ["contour", "pocket", "drilling", "chamfer", "thread"] },
        fourAxis: { nativeRotaryRelief: true, base: true, smartCutoff: true, modelLimit: 1, customOperations: [] },
        note: "Uses only workflows supported by the installed Nest Studio build. 4-axis generation starts asynchronously; poll get_cam_state. Native 2D ZIP saving and arbitrary simultaneous 5-axis machining are unsupported."
      };
      case "open_file": {
        if (typeof __usermodModelImport === "undefined") throw Error("Native model-import bridge unavailable; reinstall the updated loader");
        const bytes = Uint8Array.from(atob(String(args.base64)), c => c.charCodeAt(0));
        const result = await __usermodModelImport.importFiles([new File([bytes], String(args.name), { type: "application/octet-stream" })], undefined, { axis: args.axis as "3Axis" | "4Axis" | undefined, newProject: args.newProject === true });
        if (result.error || result.imported !== 1 || !result.projectId) throw Error(result.error ?? "Model import did not complete; inspect Nest Studio before retrying");
        return result;
      }
      case "get_status": return unwrap(await window.api.device.getStatus());
      case "list_tools": return rt.tools.list();
      case "save_tool": {
        const tool = args.tool as NestStudio.Tool;
        const existing = args.replace ? (await rt.tools.list()).find(t => t.id === tool.id) : undefined;
        if (args.replace && !existing) throw Error("Tool no longer exists; refresh list_tools");
        if (existing && args.expectedVersion === undefined) throw Error("expectedVersion is required when replacing a tool");
        return rt.tools.save({ ...tool, slotNum: existing?.slotNum ?? null }, args.replace === true, args.expectedVersion as number | undefined);
      }
      case "connect_machine": return unwrap(await window.api.device.connect(args as unknown as Parameters<NestStudio.DeviceApi["connect"]>[0]));
      case "disconnect_machine": return unwrap(await window.api.device.disconnect());
      case "send_machine_command": {
        const current = unwrap(await window.api.device.getStatus());
        if (!current.connected) throw Error("No machine connected");
        const expected = args.expectedConnection as { address: string | null; connectionType: string | null } | undefined;
        if (!expected || expected.address !== (current.address ?? null) || expected.connectionType !== (current.connectionType ?? null)) throw Error("Machine connection changed during approval; no command was sent");
        return unwrap(await window.api.device.sendMessage({ type: "text", payload: String(args.command) }));
      }
      case "validate_gcode": {
        const slots = new Set<string>();
        for (const tool of await rt.tools.list()) {
          if (typeof tool.slotNum === "number" && tool.slotNum >= 1 && tool.slotNum <= 5) {
            slots.add(String(tool.slotNum));
            slots.add(`0${tool.slotNum}`);
          }
        }
        return unwrap(await window.api.gcode.validate(String(args.gcode), [...slots].sort((a, b) => Number(a) - Number(b))));
      }
      case "estimate_gcode_time": return unwrap(await window.api.gcode.estimatedTime(String(args.gcode)));
      default: {
        const bridge = (globalThis as unknown as { __usermodMcpProject?: NativeProjectBridge }).__usermodMcpProject;
        if (!bridge) throw Error("Open a project's Prepare page. If this persists, reinstall the updated loader for the native MCP project bridge.");
        return bridge.run(action, args);
      }
    }
  };
  const { Sub, KV, Button, Row, SettingsForm, Loading, Err, useInvoke } = ui.react;
  function Panel(): React.JSX.Element {
    const { data: status, error, refresh } = useInvoke<{ listening: boolean; url: string; error: string | null; mutationBusy: boolean }>("mcp:status");
    React.useEffect(() => { const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, [refresh]);
    if (error) return <Err>{error}</Err>;
    if (!status) return <Loading />;
    return <>
      <KV pairs={[["Server", status.listening ? "Listening on this PC" : status.error ?? "Not listening"], ["Endpoint", status.url], ["Action", status.mutationBusy ? "Pending in Nest Studio" : "Ready"]]} />
      <Sub>Connect an MCP client using the endpoint and bearer token in the copied configuration. Keep it private: it grants access to projects and machine actions. Raw machine commands require approval here; machining uses the native workflow.</Sub>
      <Row><Button label="Copy client configuration" onClick={async () => {
        const r = await window.usermod.invoke("mcp:client-config");
        if (!r.ok) throw Error(r.message);
        await navigator.clipboard.writeText(JSON.stringify(r.data, null, 2));
        rt.toast("MCP client configuration copied", { kind: "success" });
      }} /></Row>
      <SettingsForm modName="mcp-server" title="Settings (restart Nest Studio to apply)" reloadPostprocessors={false} fields={[{ key: "port", label: "Local port", type: "number", min: 1024, max: 65535, step: 1 }]} />
    </>;
  }
  ui.toolbar.addButton({ id: "mcp-server", title: "MCP server", order: 90, icon: () => ui.icons.puzzle(), onClick: () => { ui.react.modal("MCP server", <Panel />, { width: 560 }); } });
})();
