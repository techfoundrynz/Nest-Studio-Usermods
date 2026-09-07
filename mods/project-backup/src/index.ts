/*
 * Project backup (main): every time the app saves a project zip (store:write-binary-file, or the chunked
 * begin/append/finish variant for large files), copy the result to data/backups/<project>/<timestamp>.zip
 * and keep the newest N per project.
 *
 * mods.json settings ("project-backup"): keep (default 20)
 */
import * as fs from "node:fs";
import * as path from "node:path";

const mod: Usermod.MainMod<{ keep: number }> = {
  description: "Keeps timestamped copies of saved project zips in data/backups",
  activate(api) {
    const keep = Math.max(1, Number(api.settings.keep ?? 20));
    const tokens = new Map<string, string>(); // chunked write token -> file path
    const isProject = (p: unknown): p is string => typeof p === "string" && /\.zip$/i.test(p);

    const backup = (filePath: string): void => {
      try {
        if (!fs.existsSync(filePath)) return;
        const project = path.basename(filePath, path.extname(filePath)).replace(/[^\w.-]+/g, "_") || "project";
        const dir = path.join(api.dataDir, "backups", project);
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        fs.copyFileSync(filePath, path.join(dir, `${stamp}.zip`));
        const old = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".zip"))
          .sort()
          .slice(0, -keep);
        for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
        api.log(`backup of ${path.basename(filePath)} -> ${dir}`);
      } catch (error) {
        api.warn(`backup failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    api.intercept("store:write-binary-file", {
      after: (result, args) => {
        const [filePath] = args;
        if (isProject(filePath) && (result as { ok?: boolean } | undefined)?.ok !== false) backup(filePath);
      }
    });
    api.intercept("store:begin-binary-file-write", {
      after: (result, args) => {
        const [filePath] = args;
        const token = (result as { ok?: boolean; data?: unknown } | undefined)?.data;
        if (isProject(filePath) && typeof token === "string") tokens.set(token, filePath);
      }
    });
    api.intercept("store:finish-binary-file-write", {
      after: (result, args) => {
        const [token] = args;
        const filePath = typeof token === "string" ? tokens.get(token) : undefined;
        if (typeof token === "string") tokens.delete(token);
        if (filePath && (result as { ok?: boolean } | undefined)?.ok !== false) backup(filePath);
      }
    });
    api.intercept("store:abort-binary-file-write", {
      after: (_result, args) => {
        if (typeof args[0] === "string") tokens.delete(args[0]);
      }
    });
    api.handle("backups:open", () => api.electron.shell.openPath(path.join(api.dataDir, "backups")));
    api.log(`project-backup active (keep ${keep})`);
  }
};

export = mod;
