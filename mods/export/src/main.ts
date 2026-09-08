/*
 * Export (main): pre-fills the app's G-code save dialog from a template and, optionally, a
 * default folder, by intercepting dialog:show-save for .nc exports.
 *
 * Template variables: {name} the app's suggested name (project / face), {project} active project name from
 * the user store, {date} YYYY-MM-DD, {time} HHMM, {datetime} YYYY-MM-DD_HHMM.
 *
 * mods.json settings ("export", shared with the other halves): template (default "{name}"), saveDir ("" = last used)
 */
import * as path from "node:path";

const mod: Usermod.MainMod<{ template: string; saveDir: string }> = {
  description: "Pre-fills the G-code export dialog from a name template and default folder",
  activate(api) {
    const template = typeof api.settings.template === "string" && api.settings.template ? api.settings.template : "{name}";
    const saveDir = typeof api.settings.saveDir === "string" ? api.settings.saveDir : "";
    const pad = (n: number): string => String(n).padStart(2, "0");

    const projectName = (): string => {
      try {
        const store = api.readStore() as { projectTabs?: { activeProjectId?: string; tabItems?: { projectId?: string; projectName?: string }[] } };
        const tabs = store.projectTabs?.tabItems ?? [];
        const active = tabs.find((t) => t.projectId === store.projectTabs?.activeProjectId) ?? tabs[0];
        return active?.projectName ?? "";
      } catch {
        return "";
      }
    };
    const expand = (suggested: string): string => {
      const now = new Date();
      const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
      return template
        .replace(/\{name\}/g, suggested)
        .replace(/\{project\}/g, projectName() || suggested)
        .replace(/\{date\}/g, date)
        .replace(/\{time\}/g, time)
        .replace(/\{datetime\}/g, `${date}_${time}`)
        .replace(/[<>:"/\\|?*]+/g, "-");
    };

    api.intercept("dialog:show-save", {
      before: (args) => {
        const [options] = args;
        if (typeof options !== "object" || options === null) return;
        const o = options as { defaultPath?: string; filters?: { extensions?: string[] }[] };
        const isGcode = o.filters?.some((f) => f.extensions?.some((e) => /^(nc|gcode|tap)$/i.test(e))) ?? /\.(nc|gcode|tap)$/i.test(o.defaultPath ?? "");
        if (!isGcode) return;
        const original = o.defaultPath ?? "toolpath.nc";
        const ext = path.extname(original) || ".nc";
        const base = path.basename(original, ext);
        const name = expand(base) + ext;
        const dir = saveDir || (path.isAbsolute(original) ? path.dirname(original) : "");
        const next = { ...o, defaultPath: dir ? path.join(dir, name) : name };
        api.log(`export dialog: ${original} -> ${next.defaultPath}`);
        return [next, ...args.slice(1)];
      }
    });
    api.log(`export dialog naming active (template "${template}"${saveDir ? `, dir ${saveDir}` : ""})`);
  }
};

export = mod;
