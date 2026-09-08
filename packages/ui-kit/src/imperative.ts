/*
 * Imperative face of the kit: plain DOM builders. These return elements the caller owns and may mutate, which
 * is why they stay DOM-based rather than wrapping the React components (React-owned DOM must not be appended
 * to or edited from outside). Both faces share one stylesheet (styles.ts), so they look the same.
 */
import { TOOLBAR_ID } from "./styles";

const rt = window.usermodRuntime;
const { el } = rt;
const SETTINGS_SELECTOR = '[data-testid="prepare-app-bar-settings"]';
export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
export const icons: Usermod.UI["icons"] = {
  svg,
  puzzle: () => svg("M10.5 2.5a2.5 2.5 0 0 1 2.5 2.5v.5h2.5A2 2 0 0 1 17.5 7.5V10h.5a2.5 2.5 0 1 1 0 5h-.5v3.5a2 2 0 0 1-2 2H13v-.5a2.5 2.5 0 1 0-5 0v.5H4.5a2 2 0 0 1-2-2V15H3a2.5 2.5 0 1 0 0-5h-.5V7.5a2 2 0 0 1 2-2H8V5a2.5 2.5 0 0 1 2.5-2.5z"),
  moon: () => svg("M13.2 2.6a9.5 9.5 0 1 0 8.2 12.8 8 8 0 0 1-8.2-12.8z"),
  sun: () => svg("M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0-5.5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zm0 18a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zM1.5 12a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1zm18 0a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1zM4.6 4.6a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 1 1-1.4 1.4L4.6 6a1 1 0 0 1 0-1.4zm12 12a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 1 1-1.4 1.4L16.6 18a1 1 0 0 1 0-1.4zM19.4 4.6a1 1 0 0 1 0 1.4L18 7.4A1 1 0 1 1 16.6 6L18 4.6a1 1 0 0 1 1.4 0zm-12 12a1 1 0 0 1 0 1.4L6 19.4A1 1 0 1 1 4.6 18L6 16.6a1 1 0 0 1 1.4 0z"),
  ellipsis: () => svg("M6 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"),
  gear: () => svg("M10.3 2.5h3.4l.5 2.3a7.6 7.6 0 0 1 1.9 1.1l2.2-.8 1.7 3-1.8 1.5a7.7 7.7 0 0 1 0 2.2l1.8 1.5-1.7 3-2.2-.8a7.6 7.6 0 0 1-1.9 1.1l-.5 2.4h-3.4l-.5-2.4a7.6 7.6 0 0 1-1.9-1.1l-2.2.8-1.7-3 1.8-1.5a7.7 7.7 0 0 1 0-2.2L4 8.1l1.7-3 2.2.8a7.6 7.6 0 0 1 1.9-1.1l.5-2.3zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z")
};
function iconNode(icon: Usermod.IconSource): Node {
  if (typeof icon === "function") return icon();
  if (typeof icon === "string") return document.createTextNode(icon);
  return icon;
}

/* ------------------------------------------------------------------- menu */
const isHeading = (entry: Usermod.MenuEntry): entry is Usermod.MenuHeading => "heading" in entry;
/** Popover of clickable rows. Rows close the menu before running, so an action may open its own popover. */
export function menu(anchor: HTMLElement, items: Usermod.MenuEntry[], { width = 260, align = "right", onClose }: Usermod.MenuOptions = {}): Usermod.PopoverHandle {
  const handle = popover(anchor, { width, align, className: "usermod-menu", onClose });
  const rows = items.map((item) => {
    if (isHeading(item)) return el("div", { class: "usermod-menu-heading", text: item.heading });
    const row = el("button", {
      type: "button",
      class: "usermod-menu-item",
      title: item.title,
      onClick: () => {
        handle.close();
        Promise.resolve(item.onClick()).catch((error: unknown) => rt.toast(`${item.label}: ${message(error)}`, { kind: "error" }));
      }
    });
    row.disabled = item.disabled === true;
    if (item.icon) row.appendChild(el("span", { class: "usermod-menu-icon" }, [iconNode(item.icon)]));
    row.appendChild(el("span", { class: "usermod-menu-label", text: item.label }));
    if (item.hint) row.appendChild(el("small", { text: item.hint }));
    return row;
  });
  handle.body.replaceChildren(...rows);
  handle.reposition();
  return handle;
}

/* ---------------------------------------------------------------- toolbar */
interface ToolbarEntry {
  options: Usermod.ToolbarButtonOptions;
  order: number;
  badge: boolean;
  /** The app-bar button, or null while this entry sits in the overflow menu. */
  button: HTMLButtonElement | null;
}
const toolbarEntries = new Map<string, ToolbarEntry>();
/** Usermod icons in the app bar, ellipsis included, before the rest collapse into it. */
let maxVisible = 5;
let pinnedIds = new Set<string>();
let overflowButton: HTMLButtonElement | null = null;
const isPinned = (entry: ToolbarEntry): boolean => entry.options.pinned === true || pinnedIds.has(entry.options.id);

function runButton(entry: ToolbarEntry, element: HTMLButtonElement): void {
  Promise.resolve(entry.options.onClick(element)).catch((error: unknown) => rt.toast(`${entry.options.title}: ${message(error)}`, { kind: "error" }));
}
function buildButton(entry: ToolbarEntry, className: string): HTMLButtonElement {
  const button = el("button", {
    type: "button",
    id: `usermod-tb-${entry.options.id}`,
    class: `${className} usermod-tb-btn`,
    title: entry.options.title,
    "aria-label": entry.options.ariaLabel ?? entry.options.title,
    "data-usermod-button": entry.options.id,
    "data-badge": entry.badge ? "true" : "false",
    onClick: () => runButton(entry, button),
    onContextmenu: (event: MouseEvent) => {
      if (!entry.options.onContextMenu) return;
      event.preventDefault();
      Promise.resolve(entry.options.onContextMenu(button)).catch((error: unknown) => rt.toast(`${entry.options.title}: ${message(error)}`, { kind: "error" }));
    }
  });
  button.appendChild(iconNode(entry.options.icon));
  entry.button = button;
  return button;
}
/** The ellipsis button: one element reused across mounts so the app bar is not rebuilt on every change. */
function buildOverflowButton(className: string, hidden: ToolbarEntry[]): HTMLButtonElement {
  const button =
    overflowButton ??
    el("button", {
      type: "button",
      id: "usermod-tb-overflow",
      class: `${className} usermod-tb-btn`,
      title: "More mods",
      "aria-label": "More mods",
      "data-usermod-button": "overflow",
      onClick: () => openOverflowMenu()
    });
  if (!overflowButton) button.appendChild(icons.ellipsis());
  overflowButton = button;
  button.setAttribute("data-badge", hidden.some((e) => e.badge) ? "true" : "false");
  const count = hidden.length + rt.menu.actions().length;
  button.title = count ? `More mods (${count})` : "More mods";
  return button;
}
function openOverflowMenu(): void {
  const anchor = overflowButton;
  if (!anchor) return;
  const items: Usermod.MenuEntry[] = [];
  const hidden = orderedEntries().filter((entry) => entry.button === null);
  for (const entry of hidden) {
    items.push({
      label: entry.options.title,
      icon: entry.options.icon,
      title: entry.options.title,
      onClick: () => runButton(entry, anchor)
    });
  }
  // Legacy rt.menu.addAction entries, grouped by section, so older mods still have a home.
  const sections = new Map<string, Usermod.RegisteredMenuAction[]>();
  for (const action of rt.menu.actions()) sections.set(action.section, [...(sections.get(action.section) ?? []), action]);
  for (const [section, actions] of sections) {
    items.push({ heading: section });
    for (const action of actions) {
      items.push({
        label: action.label,
        icon: action.icon,
        title: action.title,
        onClick: () => action.onClick({ close: closePopovers, refresh: () => Promise.resolve() })
      });
    }
  }
  if (!items.length) items.push({ label: "No other mod UI", onClick: () => undefined, disabled: true });
  menu(anchor, items, { width: 280 });
}
const orderedEntries = (): ToolbarEntry[] =>
  [...toolbarEntries.values()].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || a.order - b.order || a.options.id.localeCompare(b.options.id));

function mountToolbar(): void {
  const settings = document.querySelector<HTMLButtonElement>(SETTINGS_SELECTOR);
  if (!settings) return;
  let container = document.getElementById(TOOLBAR_ID);
  if (!container) {
    container = el("span", { id: TOOLBAR_ID });
    settings.insertAdjacentElement("afterend", container);
  }
  const ordered = orderedEntries();
  const legacyActions = rt.menu.actions().length;
  const limit = Math.max(2, maxVisible);
  // The ellipsis takes the last slot when anything has to collapse into it.
  const needsOverflow = ordered.length > limit || (ordered.length === limit && legacyActions > 0);
  const visibleCount = needsOverflow ? limit - 1 : ordered.length;
  const wanted: HTMLElement[] = [];
  for (const [index, entry] of ordered.entries()) {
    if (index < visibleCount) {
      wanted.push(entry.button?.isConnected && entry.button.parentElement === container ? entry.button : buildButton(entry, settings.className));
      continue;
    }
    entry.button = null; // lives in the overflow menu now
  }
  if (needsOverflow || legacyActions > 0) wanted.push(buildOverflowButton(settings.className, ordered.slice(visibleCount)));
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
  // Menu actions may be registered after the toolbar first mounts.
  rt.menu.onChange(() => mountToolbar());
}
export const toolbar: Usermod.UI["toolbar"] = {
  addButton(options) {
    if (!options.id || !options.title || typeof options.onClick !== "function") throw new Error("toolbar.addButton needs id, title, onClick");
    const entry: ToolbarEntry = { options, order: options.order ?? 100, badge: false, button: null };
    toolbarEntries.set(options.id, entry);
    ensureToolbarObserver();
    mountToolbar();
    return {
      id: options.id,
      /** The app-bar button, or the ellipsis button while this mod sits in the overflow menu. */
      element: () => entry.button ?? overflowButton,
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
        if (!entry.button && overflowButton) overflowButton.setAttribute("data-badge", orderedEntries().some((e) => e.button === null && e.badge) ? "true" : "false");
      },
      remove() {
        toolbar.removeButton(options.id);
      }
    };
  },
  removeButton(id) {
    toolbarEntries.get(id)?.button?.remove();
    toolbarEntries.delete(id);
    mountToolbar();
  },
  buttons() {
    return [...toolbarEntries.keys()];
  },
  setMaxVisible(count) {
    const next = Math.max(2, Math.floor(count) || 5);
    if (next === maxVisible) return;
    maxVisible = next;
    mountToolbar();
  },
  maxVisible() {
    return maxVisible;
  },
  setPinned(ids) {
    pinnedIds = new Set(ids.filter((id) => typeof id === "string"));
    mountToolbar();
  },
  pinned() {
    return [...pinnedIds];
  },
  entries() {
    return orderedEntries().map((entry) => ({ id: entry.options.id, title: entry.options.title, visible: entry.button !== null, pinned: isPinned(entry) }));
  }
};

/* ---------------------------------------------------------------- popover */
const openPopovers = new Set<Usermod.PopoverHandle>();
export function popover(anchor: HTMLElement, { width = 400, align = "left", className, onClose }: Usermod.PopoverOptions = {}): Usermod.PopoverHandle {
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
    const target = event.target instanceof Node ? event.target : null;
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
export const closePopovers = (): void => {
  for (const p of openPopovers) p.close();
};

/* ------------------------------------------------------------- primitives */
const nodes = (children: Usermod.ElChild | Usermod.ElChild[]): Usermod.ElChild[] => (Array.isArray(children) ? children : [children]);
export function button(label: string, onClick: (event: MouseEvent) => void | Promise<void>, { primary = false, title, disabled = false, class: extra }: Usermod.ButtonOptions = {}): HTMLButtonElement {
  const node = el("button", {
    type: "button",
    class: `usermod-btn${primary ? " usermod-btn-primary" : ""}${extra ? ` ${extra}` : ""}`,
    text: label,
    title,
    onClick: (event: MouseEvent) => {
      Promise.resolve(onClick(event)).catch((error: unknown) => rt.toast(`${label}: ${message(error)}`, { kind: "error" }));
    }
  });
  node.disabled = disabled;
  return node;
}
export const buttonRow = (buttons: Usermod.ElChild[]): HTMLDivElement => el("div", { class: "usermod-row" }, buttons);
export const section = (title: string, children: Usermod.ElChild | Usermod.ElChild[] = []): HTMLElement => el("div", { class: "usermod-section" }, [el("h4", { text: title }), ...nodes(children)]);
export function list<T>(items: T[], render: (item: T) => Usermod.ElChild | Usermod.ElChild[], empty = "(none)"): HTMLUListElement {
  return el("ul", { class: "usermod-list" }, items.length ? items.map((item) => el("li", {}, nodes(render(item)))) : [el("li", { text: empty })]);
}
export const kv = (pairs: [string, string][]): HTMLDListElement => el("dl", { class: "usermod-kv" }, pairs.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
function field(label: string, control: HTMLElement, help?: string): HTMLLabelElement {
  return el("label", { class: "usermod-field" }, [el("span", { class: "usermod-label", text: label }), control, help ? el("small", { text: help }) : null]);
}
export function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void, help?: string): HTMLLabelElement {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "usermod-toggle", title: help }, [input, el("span", { text: label }), help ? el("small", { text: ` ${help}` }) : null]);
}
export function select(label: string, options: Usermod.SelectOption[], value: string, onChange: (value: string) => void, help?: string): HTMLLabelElement {
  const control = el("select", {}, options.map((o) => el("option", { value: o.value, text: o.label })));
  control.value = value;
  control.addEventListener("change", () => onChange(control.value));
  return field(label, control, help);
}
export function input(label: string, value: string, onChange: (value: string) => void, { type = "text", placeholder, min, max, step, help }: { type?: "text" | "number"; placeholder?: string; min?: number; max?: number; step?: number; help?: string } = {}): HTMLLabelElement {
  const control = el("input", { type, placeholder, min, max, step });
  control.value = value;
  control.addEventListener("input", () => onChange(control.value));
  return field(label, control, help);
}

/* ---------------------------------------------------------- settings form */
export function settingsForm(modName: string, { title, fields, reloadPostprocessors = true, onSaved }: Usermod.SettingsFormOptions): HTMLElement {
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

export const imperative: Omit<Usermod.UI, "version" | "react"> = {
  toolbar,
  popover,
  menu,
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
