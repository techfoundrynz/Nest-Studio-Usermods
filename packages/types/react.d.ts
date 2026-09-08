/*
 * React face of the UI kit (window.usermodUI.react). Included by @neststudio-usermods/types/renderer, so every UI
 * mod sees it. The kit bundles React 19 + ReactDOM and publishes the classic UMD globals `React` / `ReactDOM`;
 * a mod written in TSX only needs "jsx": "react" in its tsconfig (JSX compiles to React.createElement against the
 * global) and is still emitted as one plain injected script. This is a separate React from the app's own copy:
 * mount only into DOM you own (kit modal / popover bodies, your own elements), never into the app's tree.
 */
/// <reference types="react" />
/// <reference types="react-dom" />

declare namespace Usermod {
  interface ReactButtonProps {
    /** Button text (or pass children). */
    label?: string;
    children?: React.ReactNode;
    /** Async errors are shown as error toasts, like the imperative ui.button(). */
    onClick(event: React.MouseEvent<HTMLButtonElement>): void | Promise<void>;
    primary?: boolean;
    title?: string;
    disabled?: boolean;
    className?: string;
  }
  interface ReactInputProps {
    label: string;
    value: string;
    onChange(value: string): void;
    type?: "text" | "number";
    placeholder?: string;
    min?: number;
    max?: number;
    step?: number;
    help?: string;
    disabled?: boolean;
  }
  interface AsyncState<T> {
    data: T | null;
    error: string | null;
    loading: boolean;
    refresh(): Promise<void>;
  }
  interface ReactKit {
    /** React version bundled into the kit. */
    version: string;
    /** Renders into a container you own; returns an unmount function. One root per container is reused. */
    mount(container: Element, element: React.ReactNode): () => void;
    /** Kit modal whose body is a React tree; unmounted automatically when the modal closes. */
    modal(title: string, element: React.ReactNode, options?: ModalOptions): ModalHandle;
    /** Kit popover whose body is a React tree; unmounted automatically when it closes. */
    popover(anchor: HTMLElement, element: React.ReactNode, options?: PopoverOptions): PopoverHandle;

    /* Components: same class names (and therefore the same look) as the imperative helpers. */
    Section: React.FC<{ title: string; children?: React.ReactNode }>;
    /** Muted helper text (.usermod-sub). */
    Sub: React.FC<{ children?: React.ReactNode; className?: string }>;
    KV: React.FC<{ pairs: [string, React.ReactNode][] }>;
    List<T>(props: { items: T[]; render(item: T, index: number): React.ReactNode; empty?: string; keyOf?(item: T, index: number): string | number }): React.JSX.Element;
    /** Flex row of buttons / controls (.usermod-row). */
    Row: React.FC<{ children?: React.ReactNode; className?: string }>;
    Button: React.FC<ReactButtonProps>;
    Toggle: React.FC<{ label: string; checked: boolean; onChange(checked: boolean): void; help?: string; disabled?: boolean }>;
    Select: React.FC<{ label: string; options: SelectOption[]; value: string; onChange(value: string): void; help?: string; disabled?: boolean }>;
    Input: React.FC<ReactInputProps>;
    /** Preformatted monospace block (.usermod-mono). */
    Mono: React.FC<{ children?: React.ReactNode; className?: string }>;
    Err: React.FC<{ children?: React.ReactNode }>;
    Loading: React.FC<{ text?: string }>;
    /** Form bound to mods.json "settings.<modName>", saved through the loader (React twin of ui.settingsForm). */
    SettingsForm: React.FC<{ modName: string } & SettingsFormOptions>;

    /* Hooks */
    /** Loader info (usermod.info()), refreshed on demand. */
    useInfo(): AsyncState<Info>;
    /** Any usermod IPC channel; re-runs when channel or args change. */
    useInvoke<T>(channel: string, args?: unknown[]): AsyncState<T>;
    /** Generic async value with refresh(); `deps` like useEffect. */
    useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T>;
    /** Subscribe to a usermod event channel (usermod.on) for the component's lifetime. */
    useEvent<T>(channel: string, handler: (payload: T) => void): void;
    /** Live machine state from the machine-state mod (null until it answers or when that mod is off). */
    useMachineState(): MachineState | null;
    /** Current hash route ("/home", "/project", "/preview", "/device"). */
    useRoute(): string;
  }
  interface UI {
    react: ReactKit;
  }
}

interface Window {
  /** The kit's React, published as the classic UMD global so "jsx": "react" output works in injected scripts. */
  React: typeof import("react");
  /** react-dom plus react-dom/client (createRoot) merged, like the classic UMD build. */
  ReactDOM: typeof import("react-dom") & typeof import("react-dom/client");
}
