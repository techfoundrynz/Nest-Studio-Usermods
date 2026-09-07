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

/* Minimal view of the app's three.js scene managers, exposed by the installer's scene patch
 * (globalThis.__usermodSceneManagers). Only what view mods need; everything else stays opaque. */
interface UsermodVector3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): UsermodVector3Like;
  copy(v: UsermodVector3Like): UsermodVector3Like;
  clone(): UsermodVector3Like;
  add(v: UsermodVector3Like): UsermodVector3Like;
  sub(v: UsermodVector3Like): UsermodVector3Like;
  normalize(): UsermodVector3Like;
  multiplyScalar(s: number): UsermodVector3Like;
  length(): number;
}
interface UsermodQuaternionLike {
  copy(q: UsermodQuaternionLike): UsermodQuaternionLike;
  toArray(): number[];
}
interface UsermodCameraLike {
  fov: number;
  zoom: number;
  aspect: number;
  position: UsermodVector3Like;
  up: UsermodVector3Like;
  quaternion: UsermodQuaternionLike;
  lookAt(target: UsermodVector3Like): void;
  updateProjectionMatrix(): void;
}
interface UsermodCameraControllerLike {
  camera: UsermodCameraLike;
  target: UsermodVector3Like;
  distance: number;
  viewQuat: UsermodQuaternionLike;
  updateCamera(): void;
  saveState(): void;
  reset(): void;
  emit?(type: string): void;
}
interface UsermodSceneManagerLike {
  camera: UsermodCameraLike;
  cameraController: UsermodCameraControllerLike;
  renderer: { domElement: HTMLCanvasElement };
  disposed?: boolean;
  requestRender(): void;
}
declare var __usermodSceneManagers: Set<UsermodSceneManagerLike> | undefined;

/* Sandboxed preload environment (loader/preload.ts only): Electron exposes a restricted require. */
interface PreloadIpcRenderer {
  /** Electron's invoke resolves with whatever main returned; callers name the expected type. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on<T = unknown>(channel: string, listener: (event: unknown, payload: T) => void): void;
  removeListener<T = unknown>(channel: string, listener: (event: unknown, payload: T) => void): void;
}
interface PreloadElectron {
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  ipcRenderer: PreloadIpcRenderer;
}
declare function require(id: "electron"): PreloadElectron;
declare const process: { readonly contextIsolated: boolean };
