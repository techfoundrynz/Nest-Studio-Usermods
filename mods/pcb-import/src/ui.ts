(function pcbImport(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "pcb-import", version: "0.3.0" });
  const extensions = /\.(grb|gbr|ger|gerber|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gko|gm1|zip)$/i;
  const replayed = new WeakSet<Event>();
  let busy = false;
  const error = (message: unknown): void => rt.toast(String(message), { kind: "error", duration: 10_000 });
  window.usermod.on("pcb:error", error);
  const boards: { name: string; bytes: Uint8Array; submitted?: boolean }[] = [];
  window.usermod.on("pcb:boards", raw => {
    boards.push(...raw as { name: string; bytes: Uint8Array }[]);
    toolbar.setBadge(true);
    rt.toast(`${boards.length} additional board(s) ready. After the first model finishes loading, open PCB import settings to add them separately.`, { duration: 12_000 });
  });
  let importing = false;
  const importQueued = async (): Promise<void> => {
    if (importing || !boards.length) return;
    const bridge = globalThis.__usermodModelImport;
    if (!bridge) { error("Automatic board import needs the updated app patch. Reinstall the mod loader and restart Nest Studio."); return; }
    importing = true;
    try {
      while (boards.length) {
        const batch = boards.filter(board => !board.submitted);
        if (!batch.length) break;
        const files = batch.map(board => new File([Uint8Array.from(board.bytes)], board.name, { type: "model/stl" }));
        const result = await bridge.importFiles(files, (done, total, name) => rt.toast(`Importing board ${done + 1}/${total}: ${name}`));
        for (const board of batch.slice(0, result.imported)) boards.splice(boards.indexOf(board), 1);
        toolbar.setBadge(boards.length > 0);
        if (result.error || result.imported !== files.length) {
          error(`${result.error ?? "Board import stopped."} ${result.imported}/${files.length} boards added. The remaining boards are available to retry in PCB import settings.`);
          return;
        }
        rt.toast(`Imported ${result.imported} board(s) as separate models.`, { kind: "success" });
      }
    } catch (e) { error(e instanceof Error ? e.message : e); }
    finally { importing = false; }
  };
  window.usermod.on("pcb:batch", raw => {
    boards.push(...raw as { name: string; bytes: Uint8Array }[]);
    toolbar.setBadge(true);
    void importQueued();
  });
  const prompts = new Map<string, Usermod.ModalHandle>();
  window.usermod.on("pcb:prompt-expired", id => {
    if (typeof id === "string") prompts.get(id)?.close();
  });
  window.usermod.on("pcb:prompt", raw => {
    const request = raw as { id: string; name: string; thicknessMm: number; engraveDepthMm: number; summary?: { files: { name: string; role: string }[]; top: boolean; bottom: boolean; outlines: number; drills: number } };
    let thickness = String(request.thicknessMm), depth = String(request.engraveDepthMm), gap = "2", answered = false;
    let sides = request.summary?.top ? (request.summary.bottom ? "both" : "top") : "bottom", includeDrills = true;
    const modal = ui.modal("PCB engraving depth", { width: 480, onClose: () => {
      prompts.delete(request.id);
      if (!answered) void window.usermod.invoke("pcb:answer", request.id, null);
    } });
    prompts.set(request.id, modal);
    const validation = rt.el("p", { role: "alert" });
    modal.body.append(
      rt.el("p", { text: request.name }),
      rt.el("p", { text: request.summary
        ? "Boards use the outline layer's actual perimeter and cutouts, with no added border. Copper stays at the surface; clear areas are recessed. Top and bottom retain their shared coordinates. All boards are added automatically as separate models."
        : "Tracks and pads stay at the board surface. Clear areas are recessed by the engraving depth, leaving a solid base underneath. The base is a rectangle around the artwork with a 1 mm border; it is not the actual board outline." }),
      ui.input("Board thickness (mm)", thickness, value => { thickness = value; }, { type: "number", min: 0.01, max: 100, step: 0.01 }),
      ui.input("Engraving depth (mm)", depth, value => { depth = value; }, { type: "number", min: 0.001, step: 0.01, help: "Measured down from the top surface. This shapes the model; configure and check the CAM operation separately." }),
      ...(request.summary ? [
        ui.select("Copper surfaces", [
          ...(request.summary.top ? [{ label: "Top copper", value: "top" }] : []),
          ...(request.summary.bottom ? [{ label: "Bottom copper", value: "bottom" }] : []),
          ...(request.summary.top && request.summary.bottom ? [{ label: "Top and bottom copper", value: "both" }] : [])
        ], sides, value => { sides = value; }, "Bottom copper is modeled on the underside. Configure the appropriate machining side in Nest Studio."),
        ui.toggle(`Include drill holes (${request.summary.drills} drill files)`, includeDrills, value => { includeDrills = value; }, "Duplicate holes are merged. Holes and outline cutouts go through; copper recesses use the engraving depth."),
        rt.el("p", { text: `${request.summary.outlines} outline layer(s) found. Mask, paste, silkscreen and documentation are listed for reference and do not remove board material.` }),
        ui.list(request.summary.files, file => rt.el("div", { text: `${file.role}: ${file.name}` }))
      ] : [ui.input("Board separation gap (mm)", gap, value => { gap = value; }, { type: "number", min: 0, max: 100, step: 0.5, help: "Split at empty horizontal or vertical gaps at least this wide. Default: 2 mm. Increase if one board is split too much, or use 0 to keep the panel together." })]),
      validation
    );
    const submit = ui.button("Import", async () => {
      if (!globalThis.__usermodModelImport) {
        validation.textContent = "Automatic board import requires the updated app patch. Reinstall the mod loader, then restart Nest Studio.";
        return;
      }
      if (importing) { validation.textContent = "Wait for the current board import to finish."; return; }
      const thicknessMm = Number(thickness), engraveDepthMm = Number(depth);
      if (!Number.isFinite(thicknessMm) || thicknessMm < 0.01 || thicknessMm > 100 || !Number.isFinite(engraveDepthMm) || engraveDepthMm <= 0 || engraveDepthMm >= thicknessMm) {
        validation.textContent = "Enter a board thickness of 0.01–100 mm and a positive depth less than the thickness.";
        return;
      }
      const splitGapMm = Number(gap);
      if (!Number.isFinite(splitGapMm) || (splitGapMm !== 0 && (splitGapMm < 2 || splitGapMm > 100))) {
        validation.textContent = "Board separation gap must be 2–100 mm, or 0 to keep the panel together.";
        return;
      }
      if (request.summary && sides === "both" && engraveDepthMm * 2 >= thicknessMm) {
        validation.textContent = "For both sides, engraving depth must be less than half the board thickness.";
        return;
      }
      submit.disabled = true;
      const result = await window.usermod.invoke("pcb:answer", request.id, { thicknessMm, engraveDepthMm, splitGapMm, autoImport: true, ...(request.summary ? { sides, includeDrills } : {}) });
      if (!result.ok) { validation.textContent = result.message; submit.disabled = false; return; }
      answered = true;
      modal.close();
    }, { primary: true });
    modal.footer.append(ui.button("Cancel", () => modal.close()), submit);
  });
  // Convert before the app's bubbling drop handler classifies the extension. Replaying an STL
  // retains the app's normal active-project/new-project choice and model validation.
  window.addEventListener("drop", event => {
    if (replayed.has(event)) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.some(file => extensions.test(file.name))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // The drag overlay itself is removed on dragleave; replay on its stable page parent.
    const target = event.target instanceof Element
      ? event.target.closest('[data-testid="file-drag-drop-overlay"]')?.parentElement ?? event.target
      : event.target;
    target?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }));
    if (files.length !== 1) { error("Drop one Gerber layer at a time."); return; }
    if (busy) { error("A PCB layer is already being converted. Please wait."); return; }
    const file = files[0]!;
    const zip = /\.zip$/i.test(file.name);
    if (file.size > (zip ? 16 : 8) * 1024 * 1024) {
      if (zip && target) {
        const dataTransfer = new DataTransfer(); dataTransfer.items.add(file);
        const replay = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer });
        replayed.add(replay); target.dispatchEvent(replay);
      } else error("Gerber file exceeds the 8 MiB limit.");
      return;
    }
    busy = true;
    rt.toast(`Importing ${file.name}…`);
    void (async () => {
      try {
        let imported: File;
        if (zip) {
          const result = await window.usermod.invoke<{ recognized: boolean; bytes?: Uint8Array | null }>("pcb:zip", new Uint8Array(await file.arrayBuffer()), file.name);
          if (!result.ok) throw new Error(result.message);
          if (result.data.recognized && !result.data.bytes) return;
          imported = result.data.recognized ? new File([Uint8Array.from(result.data.bytes!)], `${file.name}.stl`, { type: "model/stl" }) : file;
        } else {
          const result = await window.usermod.invoke<Uint8Array | null>("pcb:convert", await file.text(), file.name);
          if (!result.ok) throw new Error(result.message);
          if (!result.data) return;
          imported = new File([Uint8Array.from(result.data)], `${file.name}.stl`, { type: "model/stl" });
        }
        if (!(target instanceof Node) || !target.isConnected) throw new Error("The drop target changed. Drop the file again in the project window.");
        const transfer = new DataTransfer();
        transfer.items.add(imported);
        const replay = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
        replayed.add(replay); target.dispatchEvent(replay);
      } catch (e) { error(e instanceof Error ? e.message : e); }
      finally { busy = false; }
    })();
  }, true);
  const toolbar = ui.toolbar.addButton({
    id: "pcb-import", title: "PCB import settings", icon: () => ui.icons.svg("M3 3h18v18H3z M7 7h3v3H7z M14 14h3v3h-3z M10 8h7v6 M8 10v7h6"),
    onClick: () => {
      const modal = ui.modal("Gerber PCB import", { width: 480 });
      if (boards.length) {
        modal.body.append(rt.el("p", { text: "Boards are imported automatically in sequence. If an import was cancelled or failed, retry the remaining boards here. Successfully added boards are not repeated. Pending boards are cleared by an app reload." }));
        if (globalThis.__usermodModelImport) modal.body.append(ui.button("Retry remaining boards", () => { modal.close(); void importQueued(); }, { disabled: importing }));
        else {
        for (const board of boards) modal.body.append(ui.button(`${board.submitted ? "Retry" : "Import"} ${board.name}`, () => {
          // The app's own model input performs placement, validation and project updates.
          const input = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find(node => /stl/i.test(node.accept));
          if (!input) { error("Open the project's Prepare view first, then import this board."); return; }
          const transfer = new DataTransfer();
          transfer.items.add(new File([Uint8Array.from(board.bytes)], board.name, { type: "model/stl" }));
          input.files = transfer.files;
          modal.close();
          input.dispatchEvent(new Event("change", { bubbles: true }));
          board.submitted = true;
          toolbar.setBadge(boards.some(item => !item.submitted));
        }));
        }
        modal.body.append(ui.button("Discard pending boards", () => { if (importing) return; boards.length = 0; toolbar.setBadge(false); modal.close(); }, { disabled: importing }));
      }
      modal.body.append(rt.el("p", { text: "Use File → Open or drop a Gerber ZIP or single layer into Nest Studio. ZIP packages combine the actual outline, selected copper surfaces and drill holes. Mask, paste and silkscreen are identified but are not machined into the board. A single copper layer still uses an inferred rectangular base with a 1 mm border." }),
        ui.settingsForm("pcb-import", {
          reloadPostprocessors: false,
          fields: [
            { key: "thicknessMm", label: "Default board thickness (mm)", type: "number", min: 0.01, max: 100, step: 0.01, placeholder: "1.6" },
            { key: "engraveDepthMm", label: "Default engraving depth (mm)", type: "number", min: 0.001, max: 100, step: 0.01, placeholder: "0.1" },
            { key: "toleranceMm", label: "Curve tolerance (mm)", type: "number", min: 0.001, max: 0.1, step: 0.001, placeholder: "0.01" }
          ]
        }));
    }
  });
})();
