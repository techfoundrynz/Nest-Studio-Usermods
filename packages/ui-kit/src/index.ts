/*
 * Nest Studio user-mod UI kit (window.usermodUI). Injected after the UI runtime and before any mod.
 *
 *   toolbar.addButton()   a button in the app bar right after the Settings gear, styled like it
 *   popover(anchor)       a dropdown panel under an element (the MODS menu is one of these)
 *   modal(), button(), buttonRow(), section(), list(), kv(), toggle(), select(), input()
 *   settingsForm(mod, fields)   edits mods.json "settings.<mod>" through the loader
 *   icons.*               small inline SVGs matching the app's 22 px icon size
 *
 * Styling keys off the app's own html[data-theme] attribute so it follows the app's light/dark mode.
 */
(function usermodUiKit(): void {
  if (window.usermodUI) return;
  const rt = window.usermodRuntime;
  const { el } = rt;
  const SETTINGS_SELECTOR = '[data-testid="prepare-app-bar-settings"]';
  const TOOLBAR_ID = "usermod-toolbar";

  rt.addStyle(
    `#${TOOLBAR_ID}{display:contents}
     .usermod-tb-btn{position:relative}
     .usermod-tb-btn svg{width:22px;height:22px;display:block;flex:none}
     .usermod-tb-btn[data-badge="true"]::after{content:"";position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:#e53935}
     .usermod-popover{position:fixed;width:400px;max-height:72vh;overflow:auto;z-index:2147483000;background:#fff;color:#111;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.28);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px 14px}
     .usermod-popover h3{margin:0 0 4px;font-size:14px}.usermod-popover .usermod-sub{color:#666;font-size:12px;margin-bottom:6px}
     .usermod-section{margin-top:12px}.usermod-section>h4{margin:0 0 4px;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.05em}
     .usermod-list{margin:0;padding-left:18px}.usermod-list li{margin:2px 0}.usermod-list small{color:#777}
     .usermod-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
     .usermod-field{display:flex;flex-direction:column;gap:3px;margin:8px 0;font-size:12px}
     .usermod-field>span.usermod-label{color:#444;font-weight:600}.usermod-field small{color:#777}
     .usermod-field input[type=text],.usermod-field input[type=number],.usermod-field select{font:13px system-ui,sans-serif;padding:5px 8px;border:1px solid #cfd4dc;border-radius:6px;background:#fff;color:#111}
     .usermod-toggle{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:13px;cursor:pointer}
     .usermod-toggle input{width:16px;height:16px;accent-color:#0f766e}
     .usermod-kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}.usermod-kv dt{color:#666}.usermod-kv dd{margin:0}
     .usermod-err{color:#b3261e}
     html[data-theme=dark] .usermod-popover{background:#262626;color:#eee}
     html[data-theme=dark] .usermod-popover .usermod-sub,html[data-theme=dark] .usermod-section>h4,html[data-theme=dark] .usermod-list small,html[data-theme=dark] .usermod-kv dt,html[data-theme=dark] .usermod-field small{color:#aaa}
     html[data-theme=dark] .usermod-field>span.usermod-label{color:#ddd}
     html[data-theme=dark] .usermod-field input[type=text],html[data-theme=dark] .usermod-field input[type=number],html[data-theme=dark] .usermod-field select{background:#1c1c1c;color:#eee;border-color:#444}
     html[data-theme=dark] .usermod-modal{background:#262626;color:#eee}html[data-theme=dark] .usermod-modal-head{border-color:#3a3a3a}html[data-theme=dark] .usermod-modal-close{color:#aaa}
     html[data-theme=dark] .usermod-btn{background:#3a3a3a;color:#eee}html[data-theme=dark] .usermod-btn:hover{background:#4a4a4a}
     html[data-theme=dark] .usermod-btn-primary{background:#0f766e;color:#fff}html[data-theme=dark] .usermod-mono{background:#1c1c1c}`,
    "ui-kit"
  );

  /* ------------------------------------------------------------------ icons */
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(pathData: string, { viewBox = "0 0 24 24", filled = true, strokeWidth = 1.8 }: { viewBox?: string; filled?: boolean; strokeWidth?: number } = {}): SVGSVGElement {
    const node = document.createElementNS(SVG_NS, "svg");
    node.setAttribute("viewBox", viewBox);
    node.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", pathData);
    if (filled) {
      p.setAttribute("fill", "currentColor");
      p.setAttribute("fill-rule", "evenodd");
    } else {
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", String(strokeWidth));
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
    }
    node.appendChild(p);
    return node;
  }
  const icons: Usermod.UI["icons"] = {
    svg,
    puzzle: () => svg("M10.5 2.5a2.5 2.5 0 0 1 2.5 2.5v.5h2.5A2 2 0 0 1 17.5 7.5V10h.5a2.5 2.5 0 1 1 0 5h-.5v3.5a2 2 0 0 1-2 2H13v-.5a2.5 2.5 0 1 0-5 0v.5H4.5a2 2 0 0 1-2-2V15H3a2.5 2.5 0 1 0 0-5h-.5V7.5a2 2 0 0 1 2-2H8V5a2.5 2.5 0 0 1 2.5-2.5z"),
    moon: () => svg("M13.2 2.6a9.5 9.5 0 1 0 8.2 12.8 8 8 0 0 1-8.2-12.8z"),
    sun: () => svg("M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0-5.5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zm0 18a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zM1.5 12a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1zm18 0a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1zM4.6 4.6a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 1 1-1.4 1.4L4.6 6a1 1 0 0 1 0-1.4zm12 12a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 1 1-1.4 1.4L16.6 18a1 1 0 0 1 0-1.4zM19.4 4.6a1 1 0 0 1 0 1.4L18 7.4A1 1 0 1 1 16.6 6L18 4.6a1 1 0 0 1 1.4 0zm-12 12a1 1 0 0 1 0 1.4L6 19.4A1 1 0 1 1 4.6 18L6 16.6a1 1 0 0 1 1.4 0z"),
    gear: () => svg("M10.3 2.5h3.4l.5 2.3a7.6 7.6 0 0 1 1.9 1.1l2.2-.8 1.7 3-1.8 1.5a7.7 7.7 0 0 1 0 2.2l1.8 1.5-1.7 3-2.2-.8a7.6 7.6 0 0 1-1.9 1.1l-.5 2.4h-3.4l-.5-2.4a7.6 7.6 0 0 1-1.9-1.1l-2.2.8-1.7-3 1.8-1.5a7.7 7.7 0 0 1 0-2.2L4 8.1l1.7-3 2.2.8a7.6 7.6 0 0 1 1.9-1.1l.5-2.3zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z")
  };
  function iconNode(icon: Usermod.IconSource): Node {
    if (typeof icon === "function") return icon();
    if (typeof icon === "string") return document.createTextNode(icon);
    return icon;
  }

  /* ---------------------------------------------------------------- toolbar */
  interface ToolbarEntry {
    options: Usermod.ToolbarButtonOptions;
    order: number;
    badge: boolean;
    button: HTMLButtonElement | null;
  }
  const toolbarEntries = new Map<string, ToolbarEntry>();

  function buildButton(entry: ToolbarEntry, className: string): HTMLButtonElement {
    const button = el("button", {
      type: "button",
      id: `usermod-tb-${entry.options.id}`,
      class: `${className} usermod-tb-btn`,
      title: entry.options.title,
      "aria-label": entry.options.ariaLabel ?? entry.options.title,
      "data-usermod-button": entry.options.id,
      "data-badge": entry.badge ? "true" : "false",
      onClick: () => {
        Promise.resolve(entry.options.onClick(button)).catch((error: unknown) => rt.toast(`${entry.options.title}: ${error instanceof Error ? error.message : String(error)}`, { kind: "error" }));
      }
    });
    button.appendChild(iconNode(entry.options.icon));
    entry.button = button;
    return button;
  }
  function mountToolbar(): void {
    const settings = document.querySelector<HTMLButtonElement>(SETTINGS_SELECTOR);
    if (!settings) return;
    let container = document.getElementById(TOOLBAR_ID);
    if (!container) {
      container = el("span", { id: TOOLBAR_ID });
      settings.insertAdjacentElement("afterend", container);
    }
    const ordered = [...toolbarEntries.values()].sort((a, b) => a.order - b.order || a.options.id.localeCompare(b.options.id));
    const wanted = ordered.map((entry) => entry.button?.isConnected && entry.button.parentElement === container ? entry.button : buildButton(entry, settings.className));
    // Only touch the DOM when the button sequence differs.
    const current = Array.from(container.children);
    if (current.length !== wanted.length || current.some((node, i) => node !== wanted[i])) container.replaceChildren(...wanted);
  }
  let toolbarObserverStarted = false;
  function ensureToolbarObserver(): void {
    if (toolbarObserverStarted) return;
    toolbarObserverStarted = true;
    rt.waitFor(SETTINGS_SELECTOR, { timeout: 60000 }).then(mountToolbar).catch(() => undefined);
    rt.observe(() => {
      if (!document.getElementById(TOOLBAR_ID) && document.querySelector(SETTINGS_SELECTOR)) mountToolbar();
    });
  }
  const toolbar: Usermod.UI["toolbar"] = {
    addButton(options) {
      if (!options.id || !options.title || typeof options.onClick !== "function") throw new Error("toolbar.addButton needs id, title, onClick");
      const entry: ToolbarEntry = { options, order: options.order ?? 100, badge: false, button: null };
      toolbarEntries.set(options.id, entry);
      ensureToolbarObserver();
      mountToolbar();
      return {
        id: options.id,
        element: () => entry.button,
        setIcon(icon) {
          entry.options.icon = icon;
          entry.button?.replaceChildren(iconNode(icon));
        },
        setTitle(title) {
          entry.options.title = title;
          if (entry.button) {
            entry.button.title = title;
            entry.button.setAttribute("aria-label", entry.options.ariaLabel ?? title);
          }
        },
        setBadge(on) {
          entry.badge = on;
          entry.button?.setAttribute("data-badge", on ? "true" : "false");
        },
        remove() {
          toolbar.removeButton(options.id);
        }
      };
    },
    removeButton(id) {
      toolbarEntries.get(id)?.button?.remove();
      toolbarEntries.delete(id);
    },
    buttons() {
      return [...toolbarEntries.keys()];
    }
  };

  /* ---------------------------------------------------------------- popover */
  const openPopovers = new Set<Usermod.PopoverHandle>();
  function popover(anchor: HTMLElement, { width = 400, align = "left", className, onClose }: Usermod.PopoverOptions = {}): Usermod.PopoverHandle {
    const body = el("div");
    const root = el("div", { class: `usermod-popover${className ? ` ${className}` : ""}`, role: "dialog", style: { width: `${width}px` } }, [body]);
    let open = true;
    const reposition = (): void => {
      const rect = anchor.getBoundingClientRect();
      const left = align === "right" ? Math.max(8, rect.right - width) : Math.min(rect.left, window.innerWidth - width - 8);
      root.style.top = `${Math.round(rect.bottom + 6)}px`;
      root.style.left = `${Math.round(Math.max(8, left))}px`;
    };
    const onOutside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target && !root.contains(target) && !anchor.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    const close = (): void => {
      if (!open) return;
      open = false;
      root.remove();
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", reposition);
      openPopovers.delete(handle);
      onClose?.();
    };
    const handle: Usermod.PopoverHandle = { root, body, close, isOpen: () => open, reposition };
    for (const other of openPopovers) other.close();
    document.body.appendChild(root);
    reposition();
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", reposition);
    openPopovers.add(handle);
    return handle;
  }
  const closePopovers = (): void => {
    for (const p of openPopovers) p.close();
  };

  /* ------------------------------------------------------------- primitives */
  const nodes = (children: Usermod.ElChild | Usermod.ElChild[]): Usermod.ElChild[] => (Array.isArray(children) ? children : [children]);
  function button(label: string, onClick: (event: MouseEvent) => void | Promise<void>, { primary = false, title, disabled = false, class: extra }: Usermod.ButtonOptions = {}): HTMLButtonElement {
    const node = el("button", {
      type: "button",
      class: `usermod-btn${primary ? " usermod-btn-primary" : ""}${extra ? ` ${extra}` : ""}`,
      text: label,
      title,
      onClick: (event: MouseEvent) => {
        Promise.resolve(onClick(event)).catch((error: unknown) => rt.toast(`${label}: ${error instanceof Error ? error.message : String(error)}`, { kind: "error" }));
      }
    });
    node.disabled = disabled;
    return node;
  }
  const buttonRow = (buttons: Usermod.ElChild[]): HTMLDivElement => el("div", { class: "usermod-row" }, buttons);
  const section = (title: string, children: Usermod.ElChild | Usermod.ElChild[] = []): HTMLElement => el("div", { class: "usermod-section" }, [el("h4", { text: title }), ...nodes(children)]);
  function list<T>(items: T[], render: (item: T) => Usermod.ElChild | Usermod.ElChild[], empty = "(none)"): HTMLUListElement {
    return el("ul", { class: "usermod-list" }, items.length ? items.map((item) => el("li", {}, nodes(render(item)))) : [el("li", { text: empty })]);
  }
  const kv = (pairs: [string, string][]): HTMLDListElement => el("dl", { class: "usermod-kv" }, pairs.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
  function field(label: string, control: HTMLElement, help?: string): HTMLLabelElement {
    return el("label", { class: "usermod-field" }, [el("span", { class: "usermod-label", text: label }), control, help ? el("small", { text: help }) : null]);
  }
  function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void, help?: string): HTMLLabelElement {
    const input = el("input", { type: "checkbox" });
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { class: "usermod-toggle", title: help }, [input, el("span", { text: label }), help ? el("small", { text: ` ${help}` }) : null]);
  }
  function select(label: string, options: Usermod.SelectOption[], value: string, onChange: (value: string) => void, help?: string): HTMLLabelElement {
    const control = el("select", {}, options.map((o) => el("option", { value: o.value, text: o.label })));
    control.value = value;
    control.addEventListener("change", () => onChange(control.value));
    return field(label, control, help);
  }
  function input(label: string, value: string, onChange: (value: string) => void, { type = "text", placeholder, min, max, step, help }: { type?: "text" | "number"; placeholder?: string; min?: number; max?: number; step?: number; help?: string } = {}): HTMLLabelElement {
    const control = el("input", { type, placeholder, min, max, step });
    control.value = value;
    control.addEventListener("input", () => onChange(control.value));
    return field(label, control, help);
  }

  /* ---------------------------------------------------------- settings form */
  function settingsForm(modName: string, { title, fields, reloadPostprocessors = true, onSaved }: Usermod.SettingsFormOptions): HTMLElement {
    const root = el("div", { class: "usermod-settings-form" }, [title ? el("h4", { text: title }) : null, el("div", { text: "Loading…" })]);
    void window.usermod.info().then((info) => {
      if (!info.ok) {
        root.replaceChildren(el("div", { class: "usermod-err", text: info.message }));
        return;
      }
      const values: Record<string, unknown> = { ...(info.data.config.settings[modName] ?? {}) };
      const controls = fields.map((f) => {
        const current = values[f.key];
        switch (f.type) {
          case "boolean":
            return toggle(f.label, Boolean(current), (v) => (values[f.key] = v), f.help);
          case "select":
            return select(f.label, f.options ?? [], String(current ?? f.options?.[0]?.value ?? ""), (v) => (values[f.key] = v), f.help);
          case "number":
            return input(f.label, current == null ? "" : String(current), (v) => (values[f.key] = v === "" ? (f.nullable ? null : 0) : Number(v)), { type: "number", placeholder: f.placeholder, min: f.min, max: f.max, step: f.step, help: f.help });
          default:
            return input(f.label, current == null ? "" : String(current), (v) => (values[f.key] = v === "" && f.nullable ? null : v), { type: "text", placeholder: f.placeholder, help: f.help });
        }
      });
      const save = button(
        "Save",
        async () => {
          const r = await window.usermod.setSettings(modName, values);
          if (!r.ok) throw new Error(r.message);
          if (reloadPostprocessors) await window.usermod.reload();
          rt.toast(`${modName} settings saved`, { kind: "success" });
          await onSaved?.(values);
        },
        { primary: true }
      );
      root.replaceChildren(...(title ? [el("h4", { text: title })] : []), ...controls, buttonRow([save]));
    });
    return root;
  }

  const ui: Usermod.UI = {
    version: "0.3.0",
    toolbar,
    popover,
    closePopovers,
    modal: (t, o) => rt.modal(t, o),
    button,
    buttonRow,
    section,
    list,
    kv,
    toggle,
    select,
    input,
    settingsForm,
    icons
  };
  window.usermodUI = ui;
  rt.log("info", "ui kit ready");
})();
