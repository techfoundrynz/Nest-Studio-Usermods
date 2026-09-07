/*
 * MODS menu: a toolbar button (via the UI kit) opening a popover with loader status, actions registered
 * by other mods (rt.menu.addAction) and maintenance buttons. Reference example for window.usermodUI.
 */
(function modsMenu(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  rt.register({ name: "mods-menu", version: "0.5.0" });

  let popover: Usermod.PopoverHandle | null = null;
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  async function render(): Promise<void> {
    if (!popover?.isOpen()) return;
    const info = await window.usermod.info();
    if (!info.ok) throw new Error(info.message);
    const d = info.data;
    handle.setBadge(d.errors.length > 0);
    const withDesc = (name: string, desc?: string): Usermod.ElChild[] => [name, desc ? rt.el("small", { text: ` — ${desc}` }) : null];

    const sections = new Map<string, Usermod.RegisteredMenuAction[]>();
    for (const action of rt.menu.actions()) sections.set(action.section, [...(sections.get(action.section) ?? []), action]);
    const actionBlocks = [...sections].map(([name, actions]) =>
      ui.section(
        name,
        ui.buttonRow(
          actions.map((a) =>
            ui.button(a.label, () => a.onClick({ close: () => popover?.close(), refresh: render }), { title: a.title })
          )
        )
      )
    );

    const children: (Node | null)[] = [
      rt.el("h3", { text: "User mods" }),
      rt.el("div", { class: "usermod-sub", text: `Loader ${d.loaderVersion} · Nest Studio ${d.appVersion} · Electron ${d.electronVersion}` }),
      ...actionBlocks,
      ui.section("Post-processors (export order)", ui.list(d.postprocessors, (p) => withDesc(`${p.name} [${p.stages.join(", ")}]`, p.description))),
      ui.section("Main mods", ui.list(d.mainMods, (m) => withDesc(m.name, m.description))),
      ui.section("UI mods", ui.list(d.uiMods, (m) => [m.name])),
      d.errors.length > 0 ? ui.section("Recent errors", ui.list(d.errors.slice(-5), (e) => [rt.el("span", { class: "usermod-err", text: `${e.scope}: ${e.message}` })])) : null,
      ui.section(
        "Maintenance",
        ui.buttonRow([
          ui.button("Open mod folder", () => void window.usermod.openModDir()),
          ui.button(
            "Reload post-processors",
            async () => {
              await window.usermod.reload();
              await render();
              rt.toast("Post-processors and mods.json reloaded", { kind: "success" });
            },
            { title: "Re-reads mod manifests, dist/ output and mods.json without restarting" }
          ),
          ui.button(
            "Reload UI",
            () => {
              rt.toast("Reloading renderer…");
              setTimeout(() => window.location.reload(), 250);
            },
            { title: "Reloads the renderer (unsaved UI state is lost)" }
          )
        ])
      )
    ];
    popover.body.replaceChildren(...children.filter((node): node is Node => node !== null));
  }

  async function toggle(): Promise<void> {
    if (popover?.isOpen()) {
      popover.close();
      return;
    }
    const anchor = handle.element();
    if (!anchor) return;
    popover = ui.popover(anchor, { width: 400, onClose: () => (popover = null) });
    popover.body.textContent = "Loading…";
    try {
      await render();
    } catch (error) {
      popover.body.textContent = `usermod error: ${message(error)}`;
    }
  }

  const handle = ui.toolbar.addButton({
    id: "mods-menu",
    title: "User mods (Ctrl+Shift+M)",
    icon: ui.icons.puzzle,
    order: 10,
    onClick: toggle
  });

  window.usermodMenu = { toggle, close: () => popover?.close() };
})();
