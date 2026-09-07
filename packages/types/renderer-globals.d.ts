/*
 * Globals available to renderer-side code (UI runtime, UI kit, UI mods, preload block).
 * Included via @neststudio-usermods/types/renderer.
 */
interface Window {
  usermodRuntime: Usermod.Runtime;
  /** UI toolkit (packages/ui-kit), injected after the runtime and before any mod. */
  usermodUI: Usermod.UI;
  usermod: Usermod.Bridge;
  /** Nest Studio's own preload API. */
  api: NestStudio.Api;
  usermodMenu?: { toggle(): Promise<void>; close(): void };
  usermodGcodeLab?: { open(): () => void };
  usermodDarkMode?: { setTheme(theme: NestStudio.Theme): Promise<void>; toggle(): Promise<void>; current(): NestStudio.Theme };
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
