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
  /** work-zero mod: run the Z touch-plate cycle from other mods (tool-change offers it at a hold). */
  usermodZProbe?: { run(): Promise<void>; enabled(): boolean };
  /** cycles mod: open the generator dialog on a given tab. */
  usermodCycles?: { open(tab?: "thread" | "hole" | "surface"): void };
  /** Merged mods that open a tabbed window: tools (library / feeds), work-zero (offsets / probe), view. */
  usermodTools?: { open(tab?: string): void };
  usermodWorkZero?: { open(tab?: string): void };
  usermodView?: { open(tab?: string): void };
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
interface UsermodMatrix4Like {
  elements: ArrayLike<number>;
  copy(m: UsermodMatrix4Like): UsermodMatrix4Like;
}
/** Material surface a mod may read or build (constructor reachable from any existing mesh's material). */
interface UsermodMaterialLike {
  visible: boolean;
  transparent: boolean;
  opacity: number;
  dispose(): void;
  readonly constructor: UsermodMaterialCtor;
}
type UsermodMaterialCtor = new (parameters?: Record<string, unknown>) => UsermodMaterialLike;
/** Enough of three.js Object3D to walk the scene graph, recolour toolpath lines and add meshes of our own. */
interface UsermodObject3DLike {
  name: string;
  type: string;
  visible: boolean;
  renderOrder: number;
  userData: Record<string, unknown>;
  children: UsermodObject3DLike[];
  parent: UsermodObject3DLike | null;
  position: UsermodVector3Like;
  matrix: UsermodMatrix4Like;
  matrixWorld: UsermodMatrix4Like;
  matrixAutoUpdate: boolean;
  geometry?: UsermodGeometryLike;
  material?: UsermodMaterialLike;
  traverse(callback: (object: UsermodObject3DLike) => void): void;
  getObjectByName(name: string): UsermodObject3DLike | undefined;
  add(...objects: UsermodObject3DLike[]): UsermodObject3DLike;
  remove(...objects: UsermodObject3DLike[]): UsermodObject3DLike;
  updateMatrixWorld(force?: boolean): void;
  /** Object3D / Group / Mesh constructors are reachable from instances (three.js is not a global). */
  readonly constructor: UsermodObject3DCtor;
}
/** Constructing with (geometry, material) makes a Mesh; with no arguments a Group / Object3D. */
type UsermodObject3DCtor = new (geometry?: UsermodGeometryLike, material?: UsermodMaterialLike) => UsermodObject3DLike;
interface UsermodSceneManagerLike {
  camera: UsermodCameraLike;
  cameraController: UsermodCameraControllerLike;
  renderer: { domElement: HTMLCanvasElement };
  scene: UsermodObject3DLike;
  disposed?: boolean;
  requestRender(): void;
}
declare var __usermodSceneManagers: Set<UsermodSceneManagerLike> | undefined;
/** Bed size override, set by the loader's preload before the app's chunks evaluate (installer --bed-size). */
declare var __usermodBed: { X: Usermod.BedAxis; Y: Usermod.BedAxis; Z: Usermod.BedAxis } | undefined;
declare var __usermodBedPlatform: number | undefined;

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
  count?: number;
  normalized?: boolean;
  needsUpdate?: boolean;
  readonly constructor: UsermodAttributeCtor;
}
interface UsermodGeometryLike {
  boundingBox: UsermodBox3Like | null;
  index: UsermodBufferAttributeLike | null;
  getAttribute(name: string): UsermodBufferAttributeLike | undefined;
  setAttribute(name: string, attribute: UsermodBufferAttributeLike): UsermodGeometryLike;
  setIndex(index: number[]): UsermodGeometryLike;
  computeVertexNormals(): void;
  computeBoundingBox(): void;
  dispose(): void;
  readonly constructor: UsermodGeometryCtor;
}
type UsermodGeometryCtor = new () => UsermodGeometryLike;
type UsermodAttributeCtor = new (array: Float32Array, itemSize: number) => UsermodBufferAttributeLike;
interface UsermodCuttingToolLike {
  root: { visible: boolean; scale: UsermodVector3Like };
  mesh: { scale: UsermodVector3Like; geometry: UsermodGeometryLike } | null;
}
/* Stock removal (material simulation): a Z-dexel height field, stock-centred in XY, top of stock at Z = 0. */
interface UsermodDexelBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}
interface UsermodDexelSpec {
  bounds: UsermodDexelBounds;
  resolutionMm: number;
  nx: number;
  ny: number;
}
interface UsermodDexelVolumeLike {
  /** Top Z of every column (row-major, index = iy * nx + ix); bounds.minZ where the column is cut through. */
  fillTopHeights(out: Float32Array): void;
  serialize(): Float32Array;
}
interface UsermodStockRemovalLike {
  /** Group holding the app's own machined-stock meshes; added to manager.scene at identity. */
  group: UsermodObject3DLike;
  volume: UsermodDexelVolumeLike | null;
  spec: UsermodDexelSpec | null;
  timeline: { stock?: { width: number; length: number; thickness: number } } | null;
  getSampleIndex(): number;
  timelineSampleCount(): number;
  isActive(): boolean;
}
interface UsermodSimRuntimeLike {
  cuttingTool: UsermodCuttingToolLike | null;
  manager: UsermodSceneManagerLike;
  stockRemoval: UsermodStockRemovalLike | null;
  /** One G-code id per spatial sample, aligned with the sample index passed to the seek methods. */
  getSpatialGcodeIds(): string[];
  seekSpatialSample(sampleIndex: number): unknown;
  /** { sync: true, refineNormals: true } is the app's own "settle" path; huge indices clamp to the last sample. */
  seekStockRemoval(sampleIndex: number, options?: { sync?: boolean; refineNormals?: boolean }): void;
  resetStockRemoval(toolsByGcodeId: Map<string, UsermodToolMeta>): void;
}
declare var __usermodSimRuntimes: Set<UsermodSimRuntimeLike> | undefined;

/* Sandboxed preload environment (loader/preload.ts only): Electron exposes a restricted require. */
interface PreloadIpcRenderer {
  /** Electron's invoke resolves with whatever main returned; callers name the expected type. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  /** Blocking round trip, used once at preload time so the bed override is set before the app's code runs. */
  sendSync<T = unknown>(channel: string, ...args: unknown[]): T;
  on<T = unknown>(channel: string, listener: (event: unknown, payload: T) => void): void;
  removeListener<T = unknown>(channel: string, listener: (event: unknown, payload: T) => void): void;
}
interface PreloadElectron {
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  ipcRenderer: PreloadIpcRenderer;
}
declare function require(id: "electron"): PreloadElectron;
declare const process: { readonly contextIsolated: boolean };
