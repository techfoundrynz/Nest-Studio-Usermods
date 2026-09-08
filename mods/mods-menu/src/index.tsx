/*
 * MODS menu: the app-bar button opens a small panel with loader status, the build options the installed
 * archive carries, recent errors and the maintenance actions. Everything that manages mods lives in one
 * window behind "Enable/disable mods": which mods are enabled, what each one provides and whether it is loaded, how many
 * icons stay in the app bar, and the order those icons appear in.
 *
 * Reference example for the kit's React face (window.usermodUI.react): both are React components mounted
 * into kit containers with ui.react.popover() / ui.react.modal().
 */
(function modsMenu(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Section, Sub, List, Row, Button, Toggle, Input, Err, Loading, useInfo } = ui.react;
  rt.register({ name: "mods-menu", version: "0.7.0" });

  rt.addStyle(
    `.usermod-mods{width:100%;border-collapse:collapse;font-size:12px}
     .usermod-mods th,.usermod-mods td{text-align:left;padding:4px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
     .usermod-mods th{font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.05em}
     .usermod-mods td.tick{width:26px}.usermod-mods td.state{white-space:nowrap;color:#666}
     .usermod-mods tr[data-core=true] td{opacity:.75}
     .usermod-mods .name{font-weight:600}
     .usermod-mods .kinds{color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
     .usermod-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid #e5e7eb}
     .usermod-bar .grip{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
     .usermod-bar .grip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
     .usermod-bar .num{width:20px;color:#888;text-align:right;font-variant-numeric:tabular-nums}
     .usermod-bar .usermod-btn{padding:2px 7px}
     .usermod-cut{margin:6px 0 2px;padding:2px 8px;border-top:2px dashed #0f766e;color:#0f766e;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
     html[data-theme=dark] .usermod-mods th,html[data-theme=dark] .usermod-mods td,html[data-theme=dark] .usermod-bar{border-color:#3a3a3a}
     html[data-theme=dark] .usermod-mods td.state,html[data-theme=dark] .usermod-mods .kinds,html[data-theme=dark] .usermod-bar .num{color:#999}
     html[data-theme=dark] .usermod-cut{border-color:#4ade80;color:#4ade80}`,
    "mods-menu"
  );

  let popover: Usermod.PopoverHandle | null = null;
  const closeMenu = (): void => popover?.close();
  const reloadUi = (delayMs: number): void => void setTimeout(() => window.location.reload(), delayMs);
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const toastError = (error: unknown): void => rt.toast(message(error), { kind: "error" });

  /* --------------------------------------------------------- toolbar prefs */
  /** Every mod with UI owns a toolbar icon; these settings decide how many stay in the bar and in what order. */
  function applyToolbarSettings(settings: Record<string, unknown>): void {
    const max = Number(settings.toolbarMaxVisible);
    if (Number.isFinite(max) && max >= 2) ui.toolbar.setMaxVisible(max);
    const order: unknown = settings.toolbarOrder;
    if (Array.isArray(order)) ui.toolbar.setOrder(order.filter((id): id is string => typeof id === "string"));
    const pinned: unknown = settings.toolbarPinned; // older mods.json
    if (Array.isArray(pinned)) ui.toolbar.setPinned(pinned.filter((id): id is string => typeof id === "string"));
  }
  void window.usermod.info().then((r) => {
    if (r.ok) applyToolbarSettings(r.data.config.settings["mods-menu"] ?? {});
  });

  /** Strongest requirement among the toggled mods. Enabling a main mod activates it immediately, so only
   *  switching one off needs the app restart, unless the manifest declared "reload" explicitly. */
  function requiredReload(available: Usermod.AvailableMod[], chosen: Set<string>): Usermod.ReloadLevel {
    const rank: Record<Usermod.ReloadLevel, number> = { none: 0, ui: 1, app: 2 };
    let level: Usermod.ReloadLevel = "none";
    for (const m of available) {
      const willBe = chosen.has(m.name);
      if (m.core || willBe === m.enabled) continue;
      let need = m.reload;
      if (!m.reloadDeclared && need === "app" && willBe) need = m.kinds.includes("ui") ? "ui" : "none";
      if (rank[need] > rank[level]) level = need;
    }
    return level;
  }

  /* ------------------------------------------------------------ Mods window */
  /** Toolbar arrangement: the list order is the bar order, and the top few are the icons that stay in the bar. */
  function ToolbarArrangement({ settings, onSaved }: { settings: Record<string, unknown>; onSaved(): Promise<void> }): React.JSX.Element {
    const [, force] = React.useState(0);
    const entries = ui.toolbar.entries();
    const max = ui.toolbar.maxVisible();
    const visible = entries.filter((e) => e.visible).length;
    const save = async (next: Record<string, unknown>): Promise<void> => {
      const merged = { ...settings, ...next };
      applyToolbarSettings(merged); // apply live, then persist
      force((n) => n + 1);
      const r = await window.usermod.setSettings("mods-menu", merged);
      if (!r.ok) throw new Error(r.message);
      await onSaved();
    };
    const move = (index: number, delta: number): void => {
      const ids = entries.map((e) => e.id);
      const to = index + delta;
      if (to < 0 || to >= ids.length) return;
      const next = ids.slice();
      [next[index], next[to]] = [next[to]!, next[index]!];
      void save({ toolbarOrder: next }).catch(toastError);
    };
    return (
      <Section title="Toolbar">
        <Sub>Every enabled mod with UI owns one icon after the Settings gear. The top of this list is the left of the bar; the rest collapse into the ellipsis (…) menu.</Sub>
        <Input
          type="number"
          label="Icons in the app bar"
          value={String(max)}
          min={2}
          max={12}
          step={1}
          help={`${visible} of ${entries.length} fit at the moment. The ellipsis takes the last slot whenever anything is hidden.`}
          onChange={(v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 2) void save({ toolbarMaxVisible: n }).catch(toastError);
          }}
        />
        {entries.map((e, i) => (
          <React.Fragment key={e.id}>
            {i === visible ? <div className="usermod-cut">Below: in the ellipsis menu</div> : null}
            <div className="usermod-bar">
              <span className="num">{i + 1}</span>
              <span className="grip">
                <span>{e.title}</span>
                {e.pinned ? <small className="usermod-sub">pinned</small> : null}
              </span>
              <Button label="↑" title="Move left" disabled={i === 0 || e.pinned || entries[i - 1]?.pinned === true} onClick={() => move(i, -1)} />
              <Button label="↓" title="Move right" disabled={i === entries.length - 1 || entries[i + 1]?.pinned === true} onClick={() => move(i, 1)} />
            </div>
          </React.Fragment>
        ))}
        {entries.length ? (
          <Row>
            <Button label="Reset order" disabled={!ui.toolbar.order().length} onClick={() => void save({ toolbarOrder: [] }).catch(toastError)} />
          </Row>
        ) : null}
      </Section>
    );
  }

  /** One row per installed mod: enable it, see what it provides and whether the loader has it running. */
  function InstalledMods({ info, chosen, setOn }: { info: Usermod.Info; chosen: Set<string>; setOn(name: string, on: boolean): void }): React.JSX.Element {
    const postIndex = new Map(info.postprocessors.map((p, i) => [p.name, i + 1]));
    const mainActive = new Set(info.mainMods.map((m) => m.name));
    const uiLoaded = new Set(info.uiMods.map((m) => m.name));
    const barEntries = ui.toolbar.entries();
    const barState = new Map(barEntries.map((e, i) => [e.id, { position: i + 1, visible: e.visible }]));
    const rows = info.available.slice().sort((a, b) => Number(b.core) - Number(a.core) || a.name.localeCompare(b.name));
    const state = (m: Usermod.AvailableMod): string => {
      if (!m.enabled) return chosen.has(m.name) ? "enabled on save" : "off";
      const parts: string[] = [];
      const at = postIndex.get(m.name);
      if (m.kinds.includes("postprocessor")) parts.push(at ? `runs ${at} of ${info.postprocessors.length}` : "not loaded");
      if (m.kinds.includes("main")) parts.push(mainActive.has(m.name) ? "active" : "restart to activate");
      if (m.kinds.includes("ui")) {
        const bar = barState.get(m.name);
        parts.push(bar ? (bar.visible ? `icon ${bar.position} in the bar` : `icon ${bar.position}, ellipsis menu`) : uiLoaded.has(m.name) ? "loaded" : "reload the UI");
      }
      return parts.join(" · ") || "on";
    };
    return (
      <Section title={`Installed mods (${info.available.filter((m) => m.enabled && !m.core).length} of ${info.available.filter((m) => !m.core).length} on)`}>
        <table className="usermod-mods">
          <thead>
            <tr>
              <th />
              <th>Mod</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.name} data-core={m.core}>
                <td className="tick">
                  <input type="checkbox" checked={m.core || chosen.has(m.name)} disabled={m.core} title={m.core ? "Core mod: always on" : `Turn ${m.name} ${chosen.has(m.name) ? "off" : "on"}`} onChange={(e) => setOn(m.name, e.target.checked)} />
                </td>
                <td>
                  <div className="name">
                    {m.name} <span className="kinds">{m.kinds.join(" + ")}</span>
                    {m.core ? <span className="kinds"> · core</span> : null}
                  </div>
                  <div className="usermod-sub">{m.description}</div>
                </td>
                <td className="state">{state(m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    );
  }

  function ModsWindow({ info, close, refresh }: { info: Usermod.Info; close(): void; refresh(): Promise<void> }): React.JSX.Element {
    const [chosen, setChosen] = React.useState(() => new Set(info.available.filter((m) => m.enabled).map((m) => m.name)));
    const [restart, setRestart] = React.useState<{ hasUnsaved: boolean } | null>(null);
    const level = requiredReload(info.available, chosen);
    const dirty = info.available.some((m) => !m.core && chosen.has(m.name) !== m.enabled);
    const setOn = (name: string, on: boolean): void =>
      setChosen((prev) => {
        const next = new Set(prev);
        if (on) next.add(name);
        else next.delete(name);
        return next;
      });
    const save = async (): Promise<void> => {
      const r = await window.usermod.setEnabled([...chosen]);
      if (!r.ok) throw new Error(r.message);
      if (level === "none") {
        rt.toast(`Enabled: ${r.data.config.enabled.join(", ") || "none"}`, { kind: "success", duration: 4000 });
        close();
        return;
      }
      if (level === "ui") {
        rt.toast("Saved. Reloading UI…", { kind: "success" });
        reloadUi(300);
        return;
      }
      // "app": a main-process mod was switched off (or a mod declared reload: "app").
      const unsaved = await window.api.app.checkUnsavedChanges();
      setRestart({ hasUnsaved: unsaved.ok && unsaved.data === true });
    };
    return (
      <>
        <ToolbarArrangement settings={info.config.settings["mods-menu"] ?? {}} onSaved={refresh} />
        <InstalledMods info={info} chosen={chosen} setOn={setOn} />
        <Sub>
          Toolbar changes apply as you make them. Mod selection is saved with the button below: post-processors apply at once, a UI mod change reloads the UI, and switching a main-process mod off offers a restart.
          {dirty ? ` This change needs: ${level === "none" ? "nothing (applies at once)" : level === "ui" ? "a UI reload" : "an app restart"}.` : ""}
        </Sub>
        {restart ? (
          <div className="usermod-sub">
            <div>{restart.hasUnsaved ? "Saved. Nest Studio must restart to finish; you have unsaved project changes, so save them first." : "Saved. Nest Studio must restart to finish."}</div>
            <Row>
              <Button label={restart.hasUnsaved ? "Restart anyway (unsaved work is lost)" : "Restart Nest Studio now"} primary={!restart.hasUnsaved} onClick={async () => void (await window.usermod.relaunch())} />
              <Button label="Later" onClick={close} />
            </Row>
          </div>
        ) : (
          <Row>
            <Button label="Save mod selection" primary disabled={!dirty} onClick={save} />
            <Button label="Open mod folder" onClick={() => void window.usermod.openModDir()} />
            <Button label={dirty ? "Cancel" : "Close"} onClick={close} />
          </Row>
        )}
      </>
    );
  }
  function openModsWindow(info: Usermod.Info, refresh: () => Promise<void>): void {
    closeMenu();
    let modal: Usermod.ModalHandle | null = null;
    modal = ui.react.modal("Mods", <ModsWindow info={info} close={() => modal?.close()} refresh={refresh} />, { width: 720 });
  }

  /* ------------------------------------------------------------ menu panel */
  const withDesc = (name: string, desc?: string): React.ReactNode => (
    <>
      {name}
      {desc ? <small>{` — ${desc}`}</small> : null}
    </>
  );
  function MenuPanel(): React.JSX.Element {
    const { data: d, error, refresh } = useInfo();
    React.useEffect(() => {
      if (d) handle.setBadge(d.errors.length > 0);
    }, [d]);
    if (error) return <Err>usermod error: {error}</Err>;
    if (!d) return <Loading />;

    const enabledCount = d.available.filter((m) => m.enabled && !m.core).length;
    const total = d.available.filter((m) => !m.core).length;
    return (
      <>
        <h3>User mods</h3>
        <Sub>{`Loader ${d.loaderVersion} · Nest Studio ${d.appVersion} · Electron ${d.electronVersion} · React ${ui.react.version} · ${enabledCount}/${total} mods on`}</Sub>
        <Row>
          <Button label="Enable/disable mods" primary title="Enable mods, arrange the toolbar, see what is loaded" onClick={() => openModsWindow(d, refresh)} />
          <Button
            label="Reload post-processors"
            title="Re-reads mod manifests, dist/ output and mods.json without restarting"
            onClick={async () => {
              await window.usermod.reload();
              await refresh();
              rt.toast("Post-processors and mods.json reloaded", { kind: "success" });
            }}
          />
          <Button
            label="Reload UI"
            title="Reloads the renderer (unsaved UI state is lost)"
            onClick={() => {
              rt.toast("Reloading renderer…");
              reloadUi(250);
            }}
          />
        </Row>
        <Section title="Build options">
          {d.buildFlags ? (
            <List items={Object.entries(d.buildFlags.flags)} keyOf={([key]) => key} render={([key, on]) => withDesc(`${key}: ${on ? "on" : "off"}`, on ? undefined : "enable with the installer (pnpm run install:app)")} />
          ) : (
            <small>Unknown: this app was patched by an older installer. Re-run pnpm run install:app to record them.</small>
          )}
        </Section>
        {d.errors.length > 0 ? (
          <Section title="Recent errors">
            <List items={d.errors.slice(-5)} render={(e) => <span className="usermod-err">{`${e.scope}: ${e.message}`}</span>} />
          </Section>
        ) : null}
      </>
    );
  }

  async function toggle(): Promise<void> {
    if (popover?.isOpen()) {
      popover.close();
      return;
    }
    const anchor = handle.element();
    if (!anchor) return;
    popover = ui.react.popover(anchor, <MenuPanel />, { width: 400, onClose: () => (popover = null) });
  }

  const handle = ui.toolbar.addButton({
    id: "mods-menu",
    title: "User mods (Ctrl+Shift+M)",
    icon: ui.icons.puzzle,
    order: 10,
    pinned: true,
    onClick: toggle
  });

  // app-tools's Ctrl+Shift+M asks for this.
  ui.provide("mods-menu", { toggle, close: closeMenu });
})();
