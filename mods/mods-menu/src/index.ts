/*
 * MODS menu: a button in the app bar right after the Settings gear, opening a dropdown panel with
 * loader status, registered actions (rt.menu.addAction from other mods) and maintenance buttons.
 * Anchored on data-testid attributes (stable across builds) and re-inserted if the header remounts.
 */
(function modsMenu(): void {
  const rt = window.usermodRuntime;
  rt.register({ name: "mods-menu", version: "0.4.0" });

  const BUTTON_ID = "usermod-appbar-btn";
  const PANEL_ID = "usermod-panel";
  const SETTINGS_SELECTOR = '[data-testid="prepare-app-bar-settings"]';

  rt.addStyle(
    `#${BUTTON_ID}{position:relative}
     #${BUTTON_ID} svg{width:22px;height:22px;display:block;flex:none}
     #${BUTTON_ID}[data-has-errors="true"]::after{content:"";position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:#e53935}
     #${PANEL_ID}{position:fixed;width:400px;max-height:72vh;overflow:auto;z-index:2147483000;background:#fff;color:#111;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.28);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px 14px}
     #${PANEL_ID} h3{margin:0 0 4px;font-size:14px}#${PANEL_ID} .sub{color:#666;font-size:12px;margin-bottom:6px}
     #${PANEL_ID} h4{margin:12px 0 4px;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.05em}
     #${PANEL_ID} ul{margin:0;padding-left:18px}#${PANEL_ID} li{margin:2px 0}#${PANEL_ID} li small{color:#777}
     #${PANEL_ID} .row{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
     #${PANEL_ID} .err{color:#b3261e}
     @media (prefers-color-scheme: dark){#${PANEL_ID}{background:#262626;color:#eee}#${PANEL_ID} .sub,#${PANEL_ID} h4,#${PANEL_ID} li small{color:#aaa}}`,
    "mods-menu"
  );

  const icon = (): SVGSVGElement => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute(
      "d",
      "M10.5 2.5a2.5 2.5 0 0 1 2.5 2.5v.5h2.5A2 2 0 0 1 17.5 7.5V10h.5a2.5 2.5 0 1 1 0 5h-.5v3.5a2 2 0 0 1-2 2H13v-.5a2.5 2.5 0 1 0-5 0v.5H4.5a2 2 0 0 1-2-2V15H3a2.5 2.5 0 1 0 0-5h-.5V7.5a2 2 0 0 1 2-2H8V5a2.5 2.5 0 0 1 2.5-2.5z"
    );
    p.setAttribute("fill", "currentColor");
    p.setAttribute("fill-rule", "evenodd");
    svg.appendChild(p);
    return svg;
  };

  let panel: HTMLDivElement | null = null;
  function closePanel(): void {
    if (panel) {
      panel.remove();
      panel = null;
      document.removeEventListener("mousedown", onOutside, true);
    }
  }
  function onOutside(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (panel && target && !panel.contains(target) && !target.closest(`#${BUTTON_ID}`)) closePanel();
  }

  const btn = (label: string, onClick: () => void | Promise<void>, title?: string): HTMLButtonElement =>
    rt.el("button", { class: "usermod-btn", text: label, title, onClick });

  /** replaceChildren() would render null as the text "null"; keep only real nodes. */
  const nodes = (...items: (Node | null | undefined | false)[]): Node[] => items.filter((n): n is Node => Boolean(n));

  async function render(button: HTMLButtonElement): Promise<void> {
    if (!panel) return;
    const info = await window.usermod.info();
    if (!info.ok) throw new Error(info.message);
    const d = info.data;
    button.dataset.hasErrors = d.errors.length ? "true" : "false";
    const list = <T>(items: T[], fmt: (item: T) => Usermod.ElChild[]): HTMLUListElement =>
      rt.el("ul", {}, items.length ? items.map((i) => rt.el("li", {}, fmt(i))) : [rt.el("li", { text: "(none)" })]);
    const withDesc = (name: string, desc?: string): Usermod.ElChild[] => [name, desc ? rt.el("small", { text: ` — ${desc}` }) : null];

    const sections = new Map<string, Usermod.RegisteredMenuAction[]>();
    for (const action of rt.menu.actions()) {
      const bucket = sections.get(action.section) ?? [];
      bucket.push(action);
      sections.set(action.section, bucket);
    }
    const actionBlocks: Node[] = [];
    for (const [section, actions] of sections) {
      actionBlocks.push(rt.el("h4", { text: section }));
      actionBlocks.push(
        rt.el(
          "div",
          { class: "row" },
          actions.map((a) =>
            btn(
              a.label,
              async () => {
                try {
                  await a.onClick({ close: closePanel, refresh: () => render(button) });
                } catch (error) {
                  rt.toast(`${a.label}: ${error instanceof Error ? error.message : String(error)}`, { kind: "error" });
                }
              },
              a.title
            )
          )
        )
      );
    }

    panel.replaceChildren(
      ...nodes(
        rt.el("h3", { text: "User mods" }),
        rt.el("div", { class: "sub", text: `Loader ${d.loaderVersion} · Nest Studio ${d.appVersion} · Electron ${d.electronVersion}` }),
        ...actionBlocks,
        rt.el("h4", { text: "Post-processors (export order)" }),
        list(d.postprocessors, (p) => withDesc(`${p.name} [${p.stages.join(", ")}]`, p.description)),
        rt.el("h4", { text: "Main mods" }),
        list(d.mainMods, (m) => withDesc(m.name, m.description)),
        rt.el("h4", { text: "UI mods" }),
        list(d.uiMods, (m) => [m.name]),
        d.errors.length > 0 && rt.el("h4", { text: "Recent errors", class: "err" }),
        d.errors.length > 0 && list(d.errors.slice(-5), (e) => [`${e.scope}: ${e.message}`]),
        rt.el("h4", { text: "Maintenance" }),
        rt.el("div", { class: "row" }, [
          btn("Open mod folder", () => void window.usermod.openModDir()),
          btn(
            "Reload post-processors",
            async () => {
              await window.usermod.reload();
              await render(button);
              rt.toast("Post-processors and mods.json reloaded", { kind: "success" });
            },
            "Re-reads dist/postprocessors/*.js and mods.json without restarting"
          ),
          btn(
            "Reload UI",
            () => {
              rt.toast("Reloading renderer…");
              setTimeout(() => window.location.reload(), 250);
            },
            "Reloads the renderer (unsaved UI state is lost)"
          )
        ])
      )
    );
  }

  async function togglePanel(button: HTMLButtonElement | null): Promise<void> {
    if (!button) return;
    if (panel) {
      closePanel();
      return;
    }
    panel = rt.el("div", { id: PANEL_ID, role: "dialog", text: "Loading…" });
    const rect = button.getBoundingClientRect();
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    panel.style.left = `${Math.round(rect.left)}px`;
    document.body.appendChild(panel);
    document.addEventListener("mousedown", onOutside, true);
    try {
      await render(button);
    } catch (error) {
      if (panel) panel.textContent = `usermod error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function mount(): void {
    if (document.getElementById(BUTTON_ID)) return;
    const settings = document.querySelector<HTMLButtonElement>(SETTINGS_SELECTOR);
    if (!settings) return;
    const button = rt.el("button", {
      id: BUTTON_ID,
      type: "button",
      class: settings.className,
      title: "User mods (Ctrl+Shift+M)",
      "aria-label": "User mods",
      "data-testid": "usermod-app-bar-button",
      onClick: () => void togglePanel(button)
    });
    button.appendChild(icon());
    settings.insertAdjacentElement("afterend", button);
    rt.log("info", "mods-menu mounted next to settings");
  }

  window.usermodMenu = {
    toggle: () => togglePanel(document.getElementById(BUTTON_ID) as HTMLButtonElement | null),
    close: closePanel
  };

  rt.waitFor(SETTINGS_SELECTOR, { timeout: 60000 })
    .then(mount)
    .catch((e: unknown) => rt.log("warn", e instanceof Error ? e.message : String(e)));
  rt.observe(() => {
    if (!document.getElementById(BUTTON_ID)) {
      closePanel();
      mount();
    }
  });
})();
