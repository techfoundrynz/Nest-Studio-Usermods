/*
 * The kit's stylesheet. It is the contract between the imperative helpers and the React components: both emit
 * the same class names, so UI built either way (or mixed) looks identical. Colours key off the app's own
 * html[data-theme] attribute so kit UI follows Nest Studio's light/dark mode.
 */
export const TOOLBAR_ID = "usermod-toolbar";

export const STYLE = `#${TOOLBAR_ID}{display:contents}
.usermod-tb-btn{position:relative}
.usermod-tb-btn svg{width:22px;height:22px;display:block;flex:none}
.usermod-tb-btn[data-badge="true"]::after{content:"";position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:#e53935}
.usermod-popover{position:fixed;width:400px;max-height:72vh;overflow:auto;z-index:2147483000;background:#fff;color:#111;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.28);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px 14px}
.usermod-popover h3{margin:0 0 4px;font-size:14px}.usermod-popover .usermod-sub{color:#666;font-size:12px;margin-bottom:6px}
.usermod-sub{color:#666;font-size:12px}
.usermod-section{margin-top:12px}.usermod-section>h4{margin:0 0 4px;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.05em}
.usermod-list{margin:0;padding-left:18px}.usermod-list li{margin:2px 0}.usermod-list small{color:#777}
.usermod-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;align-items:center}
.usermod-field{display:flex;flex-direction:column;gap:3px;margin:8px 0;font-size:12px}
.usermod-field>span.usermod-label{color:#444;font-weight:600}.usermod-field small{color:#777}
.usermod-field input[type=text],.usermod-field input[type=number],.usermod-field select,.usermod-field textarea{font:13px system-ui,sans-serif;padding:5px 8px;border:1px solid #cfd4dc;border-radius:6px;background:#fff;color:#111}
.usermod-field textarea{font:12px/1.4 ui-monospace,Consolas,monospace;min-height:64px;resize:vertical}
.usermod-toggle{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:13px;cursor:pointer}
.usermod-toggle input{width:16px;height:16px;accent-color:#0f766e}
.usermod-kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}.usermod-kv dt{color:#666}.usermod-kv dd{margin:0}
.usermod-err{color:#b3261e}.usermod-ok{color:#166534}
html[data-theme=dark] .usermod-popover{background:#262626;color:#eee}
html[data-theme=dark] .usermod-sub,html[data-theme=dark] .usermod-popover .usermod-sub,html[data-theme=dark] .usermod-section>h4,html[data-theme=dark] .usermod-list small,html[data-theme=dark] .usermod-kv dt,html[data-theme=dark] .usermod-field small{color:#aaa}
html[data-theme=dark] .usermod-field>span.usermod-label{color:#ddd}
html[data-theme=dark] .usermod-field input[type=text],html[data-theme=dark] .usermod-field input[type=number],html[data-theme=dark] .usermod-field select,html[data-theme=dark] .usermod-field textarea{background:#1c1c1c;color:#eee;border-color:#444}
html[data-theme=dark] .usermod-modal{background:#262626;color:#eee}html[data-theme=dark] .usermod-modal-head{border-color:#3a3a3a}html[data-theme=dark] .usermod-modal-close{color:#aaa}
html[data-theme=dark] .usermod-btn{background:#3a3a3a;color:#eee}html[data-theme=dark] .usermod-btn:hover{background:#4a4a4a}
html[data-theme=dark] .usermod-btn-primary{background:#0f766e;color:#fff}html[data-theme=dark] .usermod-mono{background:#1c1c1c}
html[data-theme=dark] .usermod-ok{color:#4ade80}html[data-theme=dark] .usermod-err{color:#f87171}`;
