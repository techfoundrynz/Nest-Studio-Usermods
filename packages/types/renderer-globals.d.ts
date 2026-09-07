/*
 * Globals available to renderer-side code (UI runtime, UI mods, preload block).
 * Included only by tsconfig.renderer.json.
 */
interface Window {
  usermodRuntime: Usermod.Runtime;
  usermod: Usermod.Bridge;
  /** Nest Studio's own preload API. */
  api: NestStudio.Api;
  usermodMenu?: { toggle(): Promise<void>; close(): void };
  usermodGcodeLab?: { open(): () => void };
}

/* Sandboxed preload environment (loader/preload.ts only): Electron exposes a restricted require. */
interface PreloadIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}
interface PreloadElectron {
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  ipcRenderer: PreloadIpcRenderer;
}
declare function require(id: "electron"): PreloadElectron;
declare const process: { readonly contextIsolated: boolean };
