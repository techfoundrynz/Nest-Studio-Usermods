/*
 * Nest Studio user-mod UI runtime. Loaded into the renderer before any mod in ui/.
 * Gives mods helpers for waiting on the React UI, styling, modals, the MODS menu registry,
 * and talking to the main process. Exposed as window.usermodRuntime.
 */
(function usermodRuntime() {
  if (window.usermodRuntime) return;
  const registry = new Map();
  const menuActions = [];

  const log = (level, ...values) => {
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    method("[usermod]", ...values);
    if (window.usermod) void window.usermod.log(level, ...values.map((v) => (typeof v === "string" ? v : safeJson(v))));
  };
  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function waitFor(selector, { timeout = 30000, root = document } = {}) {
    return new Promise((resolve, reject) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const found = root.querySelector(selector);
        if (found) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(found);
        }
      });
      observer.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`usermod waitFor timed out: ${selector}`));
      }, timeout);
    });
  }
  function observe(callback, root = document.body || document.documentElement) {
    const observer = new MutationObserver((mutations) => callback(mutations));
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }
  function onRoute(callback) {
    const fire = () => callback(window.location.hash.replace(/^#/, "") || "/");
    window.addEventListener("hashchange", fire);
    queueMicrotask(fire);
    return () => window.removeEventListener("hashchange", fire);
  }
  function addStyle(css, id) {
    const styleId = id ? `usermod-style-${id}` : undefined;
    if (styleId) {
      const existing = document.getElementById(styleId);
      if (existing) existing.remove();
    }
    const style = document.createElement("style");
    if (styleId) style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
    return style;
  }
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key === "class") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child == null) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }
  function toast(message, { duration = 3000, kind = "info" } = {}) {
    const host = document.getElementById("usermod-toast-host") || document.body.appendChild(el("div", { id: "usermod-toast-host" }));
    const item = el("div", { class: `usermod-toast usermod-toast-${kind}`, text: message });
    host.appendChild(item);
    setTimeout(() => item.remove(), duration);
  }

  /* Modal: returns { root, body, close }. Closes on backdrop click or Escape. */
  function modal(title, { width = 720 } = {}) {
    const body = el("div", { class: "usermod-modal-body" });
    const close = () => {
      root.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    const root = el("div", { class: "usermod-modal-backdrop", onMousedown: (event) => event.target === root && close() }, [
      el("div", { class: "usermod-modal", role: "dialog", style: { width: `${width}px` } }, [
        el("div", { class: "usermod-modal-head" }, [
          el("h3", { text: title }),
          el("button", { class: "usermod-modal-close", text: "×", title: "Close", onClick: close })
        ]),
        body
      ])
    ]);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(root);
    return { root, body, close };
  }

  addStyle(
    `#usermod-toast-host{position:fixed;bottom:64px;right:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none}
     .usermod-toast{background:#1f1f1f;color:#fff;padding:8px 12px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:.95}
     .usermod-toast-error{background:#9b1c1c}.usermod-toast-warn{background:#8a5a00}.usermod-toast-success{background:#166534}
     .usermod-modal-backdrop{position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
     .usermod-modal{max-width:95vw;max-height:88vh;display:flex;flex-direction:column;background:#fff;color:#111;border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,.4);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
     .usermod-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e5e7eb}
     .usermod-modal-head h3{margin:0;font-size:15px}
     .usermod-modal-close{background:transparent;border:0;font-size:22px;line-height:1;cursor:pointer;color:#666;padding:0 4px}
     .usermod-modal-body{padding:14px 16px;overflow:auto}
     .usermod-btn{background:#eef0f3;border:0;border-radius:6px;padding:6px 10px;font:12px system-ui,sans-serif;cursor:pointer;color:#111}
     .usermod-btn:hover{background:#dfe3e8}.usermod-btn:disabled{opacity:.5;cursor:default}
     .usermod-btn-primary{background:#0f766e;color:#fff}.usermod-btn-primary:hover{background:#0d5f59}
     .usermod-mono{font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre;overflow:auto;background:#f6f7f9;border-radius:6px;padding:8px;max-height:260px}
     .usermod-kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}.usermod-kv dt{color:#666}.usermod-kv dd{margin:0}
     @media (prefers-color-scheme: dark){.usermod-modal{background:#262626;color:#eee}.usermod-modal-head{border-color:#3a3a3a}.usermod-modal-close{color:#aaa}
       .usermod-btn{background:#3a3a3a;color:#eee}.usermod-btn:hover{background:#4a4a4a}.usermod-mono{background:#1c1c1c}.usermod-kv dt{color:#aaa}}`,
    "runtime"
  );

  function register(mod) {
    if (!mod || !mod.name) throw new Error("usermod register() needs a name");
    registry.set(mod.name, mod);
    log("info", `ui mod registered: ${mod.name}`);
    return mod;
  }

  /* MODS menu registry: any UI mod can add an action; mods-menu.js renders them grouped by section. */
  const menu = {
    addAction({ id, label, onClick, section = "Tools", title, order = 100 }) {
      if (!id || !label || typeof onClick !== "function") throw new Error("menu.addAction needs id, label, onClick");
      const existing = menuActions.findIndex((a) => a.id === id);
      const action = { id, label, onClick, section, title, order };
      if (existing >= 0) menuActions[existing] = action;
      else menuActions.push(action);
    },
    removeAction(id) {
      const index = menuActions.findIndex((a) => a.id === id);
      if (index >= 0) menuActions.splice(index, 1);
    },
    actions() {
      return [...menuActions].sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order || a.label.localeCompare(b.label));
    }
  };

  const cam = {
    base: "http://127.0.0.1:9630",
    async version() {
      const response = await fetch(`${cam.base}/api/version`);
      return response.json();
    },
    async postForm(endpoint, fields) {
      const body = new FormData();
      for (const [key, value] of Object.entries(fields)) body.append(key, value);
      const response = await fetch(`${cam.base}${endpoint}`, { method: "POST", body });
      return response.json();
    }
  };

  const formatDuration = (seconds) => {
    if (!Number.isFinite(seconds)) return String(seconds);
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h ? `${h}h ${m}m ${r}s` : m ? `${m}m ${r}s` : `${r}s`;
  };
  const formatBytes = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

  window.usermodRuntime = {
    version: "0.2.0",
    registry,
    register,
    menu,
    waitFor,
    observe,
    onRoute,
    addStyle,
    el,
    toast,
    modal,
    log,
    cam,
    formatDuration,
    formatBytes,
    get api() {
      return window.api;
    },
    get bridge() {
      return window.usermod;
    }
  };
  log("info", "ui runtime ready");
})();
