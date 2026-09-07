/*
 * Ambient types for code that runs in Electron's main process: post-processors and main mods.
 * Included only by tsconfig.main.json.
 */
declare namespace Usermod {
  interface PostprocessorContext<S extends object = Record<string, unknown>> {
    stage: Stage;
    /** Export stage: full path the app is writing to. */
    filePath?: string;
    /** Base file name (export) or the name given to the machine (send). */
    fileName?: string;
    /** Send stage: the IPC channel that carried the G-code. */
    channel?: string;
    /** True for the app's own scratch files under user data (validation, time estimate). */
    internal: boolean;
    /** This mod's block from mods.json "settings". Always treat fields as optional. */
    settings: Partial<S>;
    dataDir: string;
    log(...values: unknown[]): void;
    warn(...values: unknown[]): void;
  }

  /** Return the new G-code, or nothing to leave it unchanged. */
  type PostprocessorResult = string | undefined | void;

  interface Postprocessor<S extends object = Record<string, unknown>> {
    /** Defaults to the file name without extension. */
    name?: string;
    description?: string;
    /** Default ["export"]. */
    stages?: Stage[];
    /** Also run on the app's internal scratch files. Default false. */
    includeInternal?: boolean;
    match?(ctx: PostprocessorContext<S>): boolean;
    process(gcode: string, ctx: PostprocessorContext<S>): PostprocessorResult | Promise<PostprocessorResult>;
  }

  /** Handlers receive whatever the renderer passed; validate at the boundary. */
  type IpcHandler = (...args: any[]) => unknown;

  interface MainModApi<S extends object = Record<string, unknown>> {
    name: string;
    electron: typeof import("electron");
    app: import("electron").App;
    /** Repo root (mods.json, data/, usermod.log). */
    modDir: string;
    /** Compiled output root the mods load from. */
    distDir: string;
    dataDir: string;
    settings: Partial<S>;
    whenReady(): Promise<void>;
    log(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
    /** Registers `usermod:<channel>`; UI mods call it with usermod.invoke(channel, ...args). */
    handle(channel: string, fn: IpcHandler): void;
    /** Sends `usermod:<channel>` to the main window; UI mods listen with usermod.on(channel, cb). */
    send(channel: string, payload: unknown): void;
    getMainWindow(): import("electron").BrowserWindow | null;
    readStore(): NestStudio.Store;
    runPostprocessors(stage: Stage, gcode: string, ctx?: RunContextInput & { internal?: boolean }): Promise<string>;
  }

  interface MainMod<S extends object = Record<string, unknown>> {
    description?: string;
    activate(api: MainModApi<S>): void | Promise<void>;
  }
}
