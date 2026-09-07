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
    /** Opt-in list of enabled mod names (mods.json "enabled"). Core mods load regardless. */
    enabled: string[];
    settings: Record<string, Record<string, unknown> | undefined>;
  }
  type ModKind = "postprocessor" | "main" | "ui";
  /** What has to happen after a mod is switched on/off for the change to take effect. */
  type ReloadLevel = "none" | "ui" | "app";
  /** Every mod package found under mods/, enabled or not. */
  interface AvailableMod {
    name: string;
    description: string;
    kinds: ModKind[];
    order: number;
    enabled: boolean;
    /** Always loaded and not user-toggleable (e.g. mods-menu). */
    core: boolean;
    /** Manifest "reload", or derived: main -> "app", ui -> "ui", postprocessor -> "none". */
    reload: ReloadLevel;
    /** True when the manifest declared it (then it applies in both directions). */
    reloadDeclared: boolean;
    /** Runtime pieces already active for this mod (main mods stay active until restart). */
    active: { main: boolean; postprocessor: boolean };
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
    /** Runtime pieces (ui-runtime, ui-kit) injected before mods; not user mods. */
    builtin?: boolean;
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
    available: AvailableMod[];
    errors: LoaderError[];
    /** Build options the installer baked into the installed archive (build/flags.json), if known. */
    buildFlags?: { appVersion?: string; installedAt?: string; flags: Record<string, boolean> };
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
    /** True when a file exists under the repo root (use before readFile for optional files). */
    exists(relPath: string): Promise<IpcResult<boolean>>;
    writeFile(relPath: string, text: string): Promise<IpcResult<string>>;
    log(level: LogLevel, ...values: unknown[]): Promise<IpcResult<void>>;
    reload(): Promise<IpcResult<Info>>;
    openModDir(): Promise<IpcResult<string>>;
    runPostprocessors(stage: Stage, gcode: string, ctx?: RunContextInput): Promise<IpcResult<string>>;
    /** Replace one mod's block in mods.json "settings" and reload the config. */
    setSettings(modName: string, settings: Record<string, unknown>): Promise<IpcResult<Config>>;
    /** Replace mods.json "enabled"; post-processors reload and newly enabled main mods activate at once,
     * UI mods need a renderer reload, disabled main mods stop at the next app start. */
    setEnabled(names: string[]): Promise<IpcResult<Info>>;
    /** Hard restart of Nest Studio (app.relaunch + exit). Check window.api.app.checkUnsavedChanges() first. */
    relaunch(): Promise<IpcResult<void>>;
  }

  /* ------------------------------------------------------------ renderer runtime */
  type ElChild = Node | string | null | undefined | false;
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

  /* ------------------------------------------------------------------ ui kit */
  type IconSource = string | Node | (() => Node);
  interface ToolbarButtonOptions {
    id: string;
    title: string;
    icon: IconSource;
    onClick(button: HTMLButtonElement): void | Promise<void>;
    /** Left-to-right order among usermod toolbar buttons (default 100). */
    order?: number;
    ariaLabel?: string;
  }
  interface ToolbarButtonHandle {
    readonly id: string;
    element(): HTMLButtonElement | null;
    setIcon(icon: IconSource): void;
    setTitle(title: string): void;
    /** Small red dot in the corner, e.g. "attention needed". */
    setBadge(on: boolean): void;
    remove(): void;
  }
  interface PopoverOptions {
    width?: number;
    align?: "left" | "right";
    className?: string;
    onClose?(): void;
  }
  interface PopoverHandle {
    root: HTMLElement;
    body: HTMLElement;
    close(): void;
    isOpen(): boolean;
    reposition(): void;
  }
  interface ButtonOptions {
    primary?: boolean;
    title?: string;
    disabled?: boolean;
    class?: string;
  }
  interface SelectOption {
    label: string;
    value: string;
  }
  type SettingsFieldType = "boolean" | "number" | "string" | "select";
  interface SettingsField {
    key: string;
    label: string;
    type: SettingsFieldType;
    help?: string;
    options?: SelectOption[];
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    /** Empty input stores null instead of "" / NaN. */
    nullable?: boolean;
  }
  interface SettingsFormOptions {
    title?: string;
    fields: SettingsField[];
    /** Also call usermod.reload() after saving so post-processors pick the values up (default true). */
    reloadPostprocessors?: boolean;
    onSaved?(settings: Record<string, unknown>): void | Promise<void>;
  }
  interface UI {
    version: string;
    toolbar: {
      addButton(options: ToolbarButtonOptions): ToolbarButtonHandle;
      removeButton(id: string): void;
      buttons(): string[];
    };
    popover(anchor: HTMLElement, options?: PopoverOptions): PopoverHandle;
    closePopovers(): void;
    modal(title: string, options?: { width?: number }): ModalHandle;
    button(label: string, onClick: (event: MouseEvent) => void | Promise<void>, options?: ButtonOptions): HTMLButtonElement;
    buttonRow(buttons: ElChild[]): HTMLDivElement;
    section(title: string, children?: ElChild | ElChild[]): HTMLElement;
    list<T>(items: T[], render: (item: T) => ElChild | ElChild[], empty?: string): HTMLUListElement;
    kv(pairs: [string, string][]): HTMLDListElement;
    toggle(label: string, checked: boolean, onChange: (checked: boolean) => void, help?: string): HTMLLabelElement;
    select(label: string, options: SelectOption[], value: string, onChange: (value: string) => void, help?: string): HTMLLabelElement;
    input(label: string, value: string, onChange: (value: string) => void, options?: { type?: "text" | "number"; placeholder?: string; min?: number; max?: number; step?: number; help?: string }): HTMLLabelElement;
    /** Form bound to mods.json "settings.<modName>"; saves through the loader. */
    settingsForm(modName: string, options: SettingsFormOptions): HTMLElement;
    icons: {
      svg(pathData: string, options?: { viewBox?: string; filled?: boolean; strokeWidth?: number }): SVGSVGElement;
      puzzle(): SVGSVGElement;
      moon(): SVGSVGElement;
      sun(): SVGSVGElement;
      gear(): SVGSVGElement;
    };
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
  type Theme = "light" | "dark";
  interface AppPrefs {
    language?: string;
    theme?: Theme;
    autoUpdater?: boolean;
    [key: string]: unknown;
  }
  interface Store {
    app?: AppPrefs;
    toolLibary?: { cutLibrarySettings?: Tool[]; materialSettings?: unknown[] };
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
      /** True when the user store holds unsaved project tabs. */
      checkUnsavedChanges(): Promise<Result<boolean>>;
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
      /** Replaces the whole user store (store.json). Read, modify, write. */
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
    device: DeviceApi;
    [namespace: string]: unknown;
  }
  /** Messages the app's device channel accepts (see preload device.sendMessage). */
  type DeviceMessage = { type: "text"; payload: string } | { type: "webrtc"; payload: unknown } | { type: "image"; payload: string };
  interface DeviceStatus {
    connected: boolean;
    connectionType?: string;
    address?: string;
  }
  interface DeviceApi {
    connect(options: { ipAddress: string; codeValue: string; connectionType?: string }): Promise<Result<unknown>>;
    disconnect(): Promise<Result<unknown>>;
    getStatus(): Promise<Result<DeviceStatus>>;
    sendMessage(message: DeviceMessage): Promise<Result<unknown>>;
    sendGcode(options: { fileName?: string; gcode: string; gcodeRunTime?: number; limitResult?: unknown }): Promise<Result<unknown>>;
    sendLabCommand(command: string): Promise<Result<unknown>>;
    getSerialPorts(): Promise<Result<unknown>>;
    onStreamEvent(listener: (event: unknown) => void): () => void;
    [other: string]: unknown;
  }
}
