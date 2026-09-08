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
  near: number;
  far: number;
  position: UsermodVector3Like;
  up: UsermodVector3Like;
  quaternion: UsermodQuaternionLike;
  lookAt(target: UsermodVector3Like): void;
  updateProjectionMatrix(): void;
}
interface UsermodCameraSnapshot {
  position: number[];
  target: number[];
  up: number[];
  zoom: number;
  viewQuaternion: number[];
  distance: number;
}
interface UsermodCameraControllerLike {
  camera: UsermodCameraLike;
  target: UsermodVector3Like;
  distance: number;
  /** Wheel zoom clamps distance to [minDistance, maxDistance]; pan speed is distance * panSensitivity. */
  config: { distance: number; minDistance: number; maxDistance: number; panSensitivity: number };
  viewQuat: UsermodQuaternionLike;
  updateCamera(): void;
  saveState(): void;
  getSnapshot(): UsermodCameraSnapshot;
  applySnapshot(snapshot: UsermodCameraSnapshot): void;
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

/* The preview's toolpath simulation runtime (EditorToolpathSimulationRuntime), exposed by the installer's
 * second scene patch. It owns the visible cutter and receives the per-path tool metadata. */
interface UsermodToolMeta {
  diameter?: number;
  toolType?: string;
  shankDiameter?: number;
  bladeLength?: number;
  tipAngleDeg?: number;
}
interface UsermodBox3Like {
  min: UsermodVector3Like;
  max: UsermodVector3Like;
}
/** Enough of three.js BufferGeometry / BufferAttribute to build a replacement cutter procedurally. */
interface UsermodBufferAttributeLike {
  array: ArrayLike<number>;
  itemSize: number;
}
interface UsermodGeometryLike {
  boundingBox: UsermodBox3Like | null;
  getAttribute(name: string): UsermodBufferAttributeLike | undefined;
  setAttribute(name: string, attribute: UsermodBufferAttributeLike): UsermodGeometryLike;
  setIndex(index: number[]): UsermodGeometryLike;
  computeVertexNormals(): void;
  computeBoundingBox(): void;
  dispose(): void;
}
type UsermodGeometryCtor = new () => UsermodGeometryLike;
type UsermodAttributeCtor = new (array: Float32Array, itemSize: number) => UsermodBufferAttributeLike;
interface UsermodCuttingToolLike {
  root: { visible: boolean; scale: UsermodVector3Like };
  mesh: { scale: UsermodVector3Like; geometry: UsermodGeometryLike } | null;
}
interface UsermodSimRuntimeLike {
  cuttingTool: UsermodCuttingToolLike | null;
  manager: UsermodSceneManagerLike;
  /** One G-code id per spatial sample, aligned with the sample index passed to the seek methods. */
  getSpatialGcodeIds(): string[];
  seekSpatialSample(sampleIndex: number): unknown;
  seekStockRemoval(sampleIndex: number, options?: unknown): void;
  resetStockRemoval(toolsByGcodeId: Map<string, UsermodToolMeta>): void;
}
declare var __usermodSimRuntimes: Set<UsermodSimRuntimeLike> | undefined;

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
