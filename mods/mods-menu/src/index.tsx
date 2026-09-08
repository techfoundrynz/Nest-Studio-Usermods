/*
 * MODS menu: a toolbar button (via the UI kit) opening a popover with loader status, toolbar preferences and
 * maintenance buttons, plus the Mods… dialog that switches mods on and off. Every other mod with UI owns a
 * toolbar icon of its own, so this panel no longer lists their actions.
 * Reference example for the kit's React face (window.usermodUI.react): the panel and the dialog are React
 * components mounted into kit containers with ui.react.popover() / ui.react.modal().
 */
(function modsMenu(): void {
  const rt = window.usermodRuntime;
  const ui = window.usermodUI;
  const { Section, Sub, List, Row, Button, Toggle, Input, Err, Loading, useInfo } = ui.react;
  rt.register({ name: "mods-menu", version: "0.6.0" });

  let popover: Usermod.PopoverHandle | null = null;
  const closeMenu = (): void => popover?.close();
  const reloadUi = (delayMs: number): void => void setTimeout(() => window.location.reload(), delayMs);

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

  /* ---------------------------------------------------------- Mods… dialog */
  function ModPicker({ info, close }: { info: Usermod.Info; close(): void }): React.JSX.Element {
    const [chosen, setChosen] = React.useState(() => new Set(info.available.filter((m) => m.enabled).map((m) => m.name)));
    const [restart, setRestart] = React.useState<{ hasUnsaved: boolean } | null>(null);
    const rows = info.available.slice().sort((a, b) => Number(b.core) - Number(a.core) || a.name.localeCompare(b.name));
    const level = requiredReload(info.available, chosen);
    const dirty = rows.some((m) => !m.core && chosen.has(m.name) !== m.enabled);

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
        {rows.map((m) => (
          <Toggle key={m.name} label={`${m.name}  [${m.kinds.join(" + ")}]${m.core ? "  (core, always on)" : ""}`} checked={m.core || chosen.has(m.name)} disabled={m.core} help={m.description} onChange={(on) => setOn(m.name, on)} />
        ))}
        <Sub>
          Saving applies post-processors at once, reloads the UI automatically when a UI mod changed, and offers a restart when a main-process mod was switched off.
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
            <Button label="Save" primary disabled={!dirty} onClick={save} />
            <Button label="Cancel" onClick={close} />
          </Row>
        )}
      </>
    );
  }
  function openModPicker(info: Usermod.Info): void {
    closeMenu();
    const modal = ui.modal("Mods", { width: 560 });
    ui.react.mount(modal.body, <ModPicker info={info} close={modal.close} />);
  }

  /* --------------------------------------------------------- toolbar prefs */
  /** Every mod with UI owns a toolbar icon; these settings decide how many stay in the bar and which ones. */
  function applyToolbarSettings(settings: Record<string, unknown>): void {
    const max = Number(settings.toolbarMaxVisible);
    if (Number.isFinite(max) && max >= 2) ui.toolbar.setMaxVisible(max);
    const pinned: unknown = settings.toolbarPinned;
    if (Array.isArray(pinned)) ui.toolbar.setPinned(pinned.filter((id): id is string => typeof id === "string"));
  }
  void window.usermod.info().then((r) => {
    if (r.ok) applyToolbarSettings(r.data.config.settings["mods-menu"] ?? {});
  });

  function ToolbarSection({ settings, onSaved }: { settings: Record<string, unknown>; onSaved(): Promise<void> }): React.JSX.Element {
    const [, force] = React.useState(0);
    const entries = ui.toolbar.entries();
    const max = ui.toolbar.maxVisible();
    const save = async (next: Record<string, unknown>): Promise<void> => {
      const merged = { ...settings, ...next };
      applyToolbarSettings(merged);
      force((n) => n + 1);
      const r = await window.usermod.setSettings("mods-menu", merged);
      if (!r.ok) throw new Error(r.message);
      await onSaved();
    };
    const setPinned = (id: string, on: boolean): Promise<void> => {
      const pinned = new Set(ui.toolbar.pinned());
      if (on) pinned.add(id);
      else pinned.delete(id);
      return save({ toolbarPinned: [...pinned] });
    };
    return (
      <Section title={`Toolbar (${entries.filter((e) => e.visible).length} of ${entries.length} in the app bar)`}>
        <Input
          type="number"
          label="Icons in the app bar"
          value={String(max)}
          min={2}
          max={12}
          step={1}
          help="The rest collapse into the ellipsis menu. The ellipsis takes the last slot when anything is hidden."
          onChange={(v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 2) void save({ toolbarMaxVisible: n });
          }}
        />
        <Sub>Tick a mod to keep its icon in the bar whatever the order:</Sub>
        {entries.map((e) => (
          <Toggle
            key={e.id}
            label={`${e.title}${e.visible ? "" : " (in the ellipsis menu)"}`}
            checked={e.pinned}
            disabled={e.id === "mods-menu"}
            onChange={(on) => void setPinned(e.id, on).catch((error: unknown) => rt.toast(error instanceof Error ? error.message : String(error), { kind: "error" }))}
          />
        ))}
      </Section>
    );
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
        <Sub>{`Loader ${d.loaderVersion} · Nest Studio ${d.appVersion} · Electron ${d.electronVersion} · ${enabledCount}/${total} mods enabled · React ${ui.react.version}`}</Sub>
        <ToolbarSection settings={d.config.settings["mods-menu"] ?? {}} onSaved={refresh} />
        <Section title="Post-processors (export order)">
          <List items={d.postprocessors} keyOf={(p) => p.name} render={(p) => withDesc(`${p.name} [${p.stages.join(", ")}]`, p.description)} />
        </Section>
        <Section title="Main mods">
          <List items={d.mainMods} keyOf={(m) => m.name} render={(m) => withDesc(m.name, m.description)} />
        </Section>
        <Section title="UI mods">
          <List items={d.uiMods} keyOf={(m) => m.name} render={(m) => m.name} />
        </Section>
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
        <Section title="Maintenance">
          <Row>
            <Button label="Mods…" primary title="Choose which mods are enabled" onClick={() => openModPicker(d)} />
            <Button label="Open mod folder" onClick={() => void window.usermod.openModDir()} />
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
        </Section>
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

  window.usermodMenu = { toggle, close: closeMenu };
})();
