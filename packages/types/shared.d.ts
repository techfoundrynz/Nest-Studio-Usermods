/*
 * Ambient types shared by the main process and the renderer.
 * Deliberately a global declaration file (no imports/exports) so the renderer build, which emits
 * classic scripts with `module: none`, can see them too.
 */
declare namespace Usermod {
  type Stage = "export" | "send";
  type LogLevel = "info" | "warn" | "error";

  /** Every usermod IPC call resolves to this shape; thrown errors never reach the renderer. */
  type IpcResult<T> = { ok: true; data: T } | { ok: false; message: string };

  interface Config {
    disabled: string[];
    settings: Record<string, Record<string, unknown> | undefined>;
  }

  interface PostprocessorSummary {
    name: string;
    file: string;
    stages: Stage[];
    description: string;
  }
  interface MainModSummary {
    name: string;
    file: string;
    description: string;
  }
  interface UiModEntry {
    name: string;
    file: string;
    url: string;
  }
  interface LoaderError {
    scope: string;
    message: string;
    time: number;
  }
  interface Info {
    loaderVersion: string;
    modDir: string;
    distDir: string;
    appVersion: string;
    electronVersion: string;
    config: Config;
    postprocessors: PostprocessorSummary[];
    mainMods: MainModSummary[];
    uiMods: UiModEntry[];
    errors: LoaderError[];
  }

  /** Context a caller may supply when running the chain manually. */
  interface RunContextInput {
    fileName?: string;
    filePath?: string;
    channel?: string;
  }

  /** window.usermod: the preload bridge to the main-process loader. */
  interface Bridge {
    invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>;
    on<T = unknown>(channel: string, callback: (payload: T) => void): () => void;
    info(): Promise<IpcResult<Info>>;
    listUiMods(): Promise<IpcResult<UiModEntry[]>>;
    readFile(relPath: string): Promise<IpcResult<string>>;
    writeFile(relPath: string, text: string): Promise<IpcResult<string>>;
    log(level: LogLevel, ...values: unknown[]): Promise<IpcResult<void>>;
    reload(): Promise<IpcResult<Info>>;
    openModDir(): Promise<IpcResult<string>>;
    runPostprocessors(stage: Stage, gcode: string, ctx?: RunContextInput): Promise<IpcResult<string>>;
  }

  /* ------------------------------------------------------------ renderer runtime */
  type ElChild = Node | string | null | undefined;
  interface ElProps {
    class?: string;
    text?: string;
    html?: string;
    style?: Partial<CSSStyleDeclaration>;
    [key: `on${string}`]: ((event: never) => void) | undefined;
    [attribute: string]: unknown;
  }
  interface ToastOptions {
    duration?: number;
    kind?: "info" | "success" | "warn" | "error";
  }
  interface ModalHandle {
    root: HTMLElement;
    body: HTMLElement;
    close(): void;
  }
  interface MenuActionContext {
    close(): void;
    refresh(): Promise<void>;
  }
  interface MenuAction {
    id: string;
    label: string;
    onClick(ctx: MenuActionContext): void | Promise<void>;
    section?: string;
    order?: number;
    title?: string;
  }
  interface RegisteredMenuAction extends MenuAction {
    section: string;
    order: number;
  }
  interface UiModDescriptor {
    name: string;
    version?: string;
  }
  interface CamVersion {
    version: string;
    time: string;
  }
  interface CamClient {
    base: string;
    version(): Promise<CamVersion>;
    postForm<T = unknown>(endpoint: string, fields: Record<string, string | Blob>): Promise<T>;
  }
  interface Runtime {
    version: string;
    registry: Map<string, UiModDescriptor>;
    register(mod: UiModDescriptor): UiModDescriptor;
    menu: {
      addAction(action: MenuAction): void;
      removeAction(id: string): void;
      actions(): RegisteredMenuAction[];
    };
    waitFor<E extends Element = HTMLElement>(selector: string, options?: { timeout?: number; root?: ParentNode }): Promise<E>;
    observe(callback: (mutations: MutationRecord[]) => void, root?: Node): () => void;
    onRoute(callback: (route: string) => void): () => void;
    addStyle(css: string, id?: string): HTMLStyleElement;
    el<K extends keyof HTMLElementTagNameMap>(tag: K, props?: ElProps, children?: ElChild | ElChild[]): HTMLElementTagNameMap[K];
    toast(message: string, options?: ToastOptions): void;
    modal(title: string, options?: { width?: number }): ModalHandle;
    log(level: LogLevel, ...values: unknown[]): void;
    cam: CamClient;
    formatDuration(seconds: number): string;
    formatBytes(bytes: number): string;
    readonly api: NestStudio.Api;
    readonly bridge: Bridge;
  }
}

/** The subset of Nest Studio's own preload API (window.api) that mods use. Shapes observed in 1.1.0. */
declare namespace NestStudio {
  type Result<T> = { ok: true; data: T } | { ok: false; code?: string; message?: string };

  interface ValidationToken {
    line: number;
    level: string;
    code: string;
    msg?: string;
    value?: string;
    beg_pos?: number;
    end_pos?: number;
  }
  interface ValidationResult {
    file?: string;
    has_err: boolean;
    tokens: ValidationToken[];
    header?: unknown[];
    limit?: unknown;
  }
  interface Tool {
    id: string;
    name: string;
    type: string;
    diameter: number;
    slotNum: number;
    [key: string]: unknown;
  }
  interface Store {
    toolLibary?: { cutLibrarySettings?: Tool[]; materialSettings?: unknown[] };
    app?: Record<string, unknown>;
    [key: string]: unknown;
  }
  interface FileFilter {
    name: string;
    extensions: string[];
  }
  interface SaveDialogOptions {
    title?: string;
    defaultPath?: string;
    filters?: FileFilter[];
  }
  interface OpenDialogOptions {
    title?: string;
    defaultPath?: string;
    filters?: FileFilter[];
    properties?: string[];
  }
  interface Api {
    app: {
      platform: string;
      getPath(name: string): Promise<Result<string>>;
      getLanguage(): Promise<Result<string>>;
    };
    gcode: {
      validate(gcode: string, toolSlots?: string[]): Promise<Result<{ result: ValidationResult }>>;
      estimatedTime(gcode: string): Promise<Result<{ motionTime: number }>>;
      arcFit(gcode: string): Promise<Result<{ gcode: string }>>;
    };
    dialog: {
      showSave(options: SaveDialogOptions): Promise<Result<{ filePath?: string; canceled?: boolean }>>;
      showOpen(options: OpenDialogOptions): Promise<Result<{ filePaths?: string[]; canceled?: boolean }>>;
    };
    store: {
      read(): Promise<Result<Store>>;
      write(data: Store): Promise<Result<void>>;
      readFile(filePath: string): Promise<Result<string>>;
      /** Goes through the loader's export hook, so post-processors apply to G-code paths. */
      writeFile(filePath: string, data: string): Promise<Result<void>>;
      exists(filePath: string): Promise<Result<boolean>>;
      getStorePath(): Promise<Result<string>>;
    };
    shell: {
      showItemInFolder(filePath: string): Promise<Result<void>>;
      openExternal(url: string): Promise<Result<void>>;
    };
    /** Device and other namespaces exist but are not typed here yet. */
    device: Record<string, (...args: never[]) => unknown>;
    [namespace: string]: unknown;
  }
}
