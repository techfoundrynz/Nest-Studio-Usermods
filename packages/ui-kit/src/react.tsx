/*
 * React face of the kit (window.usermodUI.react): components that render the same class names as the imperative
 * helpers, hooks for the loader bridge, and mount helpers that tie a React tree to a kit modal or popover.
 * The React instance here is the kit's own bundled copy, published as window.React so mod scripts compiled
 * with "jsx": "react" resolve React.createElement to the very same instance (one copy: hooks work everywhere).
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import { message, popover as imperativePopover } from "./imperative";

const rt = window.usermodRuntime;
const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ mount */
const roots = new WeakMap<Element, ReactDOMClient.Root>();
function mount(container: Element, element: React.ReactNode): () => void {
  let root = roots.get(container);
  if (!root) {
    root = ReactDOMClient.createRoot(container);
    roots.set(container, root);
  }
  root.render(element);
  return () => {
    const current = roots.get(container);
    roots.delete(container);
    current?.unmount();
  };
}
/** Unmount after the current event/render finished: closing from inside a click handler is common. */
const unmountLater = (unmount: () => void): void => void setTimeout(unmount, 0);

/*
 * The pinned footer, reachable from anywhere inside the modal's own tree. A modal's buttons usually need the
 * state that lives beside them (what is selected, whether the form is valid), so rather than asking a mod to
 * render a second, separate tree, ModalFooter portals its children out of the body and into the pinned bar
 * while leaving them where they are in the React tree. Outside a kit modal it renders nothing.
 */
const ModalFooterContext = React.createContext<HTMLElement | null>(null);
const ModalFooter: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const host = React.useContext(ModalFooterContext);
  return host ? ReactDOM.createPortal(children, host) : null;
};
interface ReactModalOptions extends Usermod.ModalOptions {
  /** Rendered into the pinned bar under the body. A function form is handed `close` for the dismiss button. */
  footer?: React.ReactNode | ((close: () => void) => React.ReactNode);
}
function modal(title: string, element: React.ReactNode, { width, onClose, footer }: ReactModalOptions = {}): Usermod.ModalHandle {
  let unmount: () => void = () => undefined;
  let unmountFooter: () => void = () => undefined;
  const handle = rt.modal(title, {
    width,
    onClose: () => {
      unmountLater(unmount);
      unmountLater(unmountFooter);
      onClose?.();
    }
  });
  unmount = mount(handle.body, <ModalFooterContext.Provider value={handle.footer}>{element}</ModalFooterContext.Provider>);
  if (footer !== undefined) unmountFooter = mount(handle.footer, typeof footer === "function" ? footer(handle.close) : footer);
  return handle;
}
function popover(anchor: HTMLElement, element: React.ReactNode, options: Usermod.PopoverOptions = {}): Usermod.PopoverHandle {
  let unmount: () => void = () => undefined;
  const handle = imperativePopover(anchor, {
    ...options,
    onClose: () => {
      unmountLater(unmount);
      options.onClose?.();
    }
  });
  unmount = mount(handle.body, element);
  return handle;
}

/* ------------------------------------------------------------------ hooks */
function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Usermod.AsyncState<T> {
  const [state, setState] = React.useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  const generation = React.useRef(0);
  const run = React.useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fnRef.current();
      if (mine === generation.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (mine === generation.current) setState((s) => ({ data: s.data, error: message(error), loading: false }));
    }
  }, []);
  const key = JSON.stringify(deps);
  React.useEffect(() => {
    void run();
    return () => {
      generation.current += 1; // drop results of the in-flight call
    };
  }, [run, key]);
  return { ...state, refresh: run };
}
function useInvoke<T>(channel: string, args: unknown[] = []): Usermod.AsyncState<T> {
  return useAsync<T>(async () => {
    const r = await window.usermod.invoke<T>(channel, ...args);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  }, [channel, args]);
}
function useInfo(): Usermod.AsyncState<Usermod.Info> {
  return useAsync(async () => {
    const r = await window.usermod.info();
    if (!r.ok) throw new Error(r.message);
    return r.data;
  }, []);
}
function useEvent<T>(channel: string, handler: (payload: T) => void): void {
  const ref = React.useRef(handler);
  ref.current = handler;
  React.useEffect(() => window.usermod.on<T>(channel, (payload) => ref.current(payload)), [channel]);
}
function useMachineState(): Usermod.MachineState | null {
  const initial = useInvoke<Usermod.MachineState>("machine:state");
  const [live, setLive] = React.useState<Usermod.MachineState | null>(null);
  useEvent<Usermod.MachineState>("machine:state", setLive);
  return live ?? initial.data;
}
const currentRoute = (): string => {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  return hash.split("?")[0] || "/";
};
function useRoute(): string {
  const [route, setRoute] = React.useState(currentRoute);
  React.useEffect(() => rt.onRoute(setRoute), []);
  return route;
}

/* ------------------------------------------------------------- components */
const Section: React.FC<{ title: string; children?: React.ReactNode }> = ({ title, children }) => (
  <div className="usermod-section">
    <h4>{title}</h4>
    {children}
  </div>
);
const Sub: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className }) => <div className={cx("usermod-sub", className)}>{children}</div>;
const KV: React.FC<{ pairs: [string, React.ReactNode][] }> = ({ pairs }) => (
  <dl className="usermod-kv">
    {pairs.map(([k, v], i) => (
      <React.Fragment key={`${i}:${k}`}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </React.Fragment>
    ))}
  </dl>
);
function List<T>({ items, render, empty = "(none)", keyOf }: { items: T[]; render(item: T, index: number): React.ReactNode; empty?: string; keyOf?(item: T, index: number): string | number }): React.JSX.Element {
  return <ul className="usermod-list">{items.length ? items.map((item, i) => <li key={keyOf ? keyOf(item, i) : i}>{render(item, i)}</li>) : <li>{empty}</li>}</ul>;
}
const Row: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className }) => <div className={cx("usermod-row", className)}>{children}</div>;
const Button: React.FC<Usermod.ReactButtonProps> = ({ label, children, onClick, primary = false, title, disabled = false, className }) => (
  <button
    type="button"
    className={cx("usermod-btn", primary && "usermod-btn-primary", className)}
    title={title}
    disabled={disabled}
    onClick={(event) => {
      Promise.resolve(onClick(event)).catch((error: unknown) => rt.toast(label ? `${label}: ${message(error)}` : message(error), { kind: "error" }));
    }}
  >
    {children ?? label}
  </button>
);
const Toggle: React.FC<{ label: string; checked: boolean; onChange(checked: boolean): void; help?: string; disabled?: boolean }> = ({ label, checked, onChange, help, disabled = false }) => (
  <label className="usermod-toggle" title={help}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span>{label}</span>
    {help ? <small>{` ${help}`}</small> : null}
  </label>
);
const Field: React.FC<{ label: string; help?: string; children?: React.ReactNode }> = ({ label, help, children }) => (
  <label className="usermod-field">
    <span className="usermod-label">{label}</span>
    {children}
    {help ? <small>{help}</small> : null}
  </label>
);
const Select: React.FC<{ label: string; options: Usermod.SelectOption[]; value: string; onChange(value: string): void; help?: string; disabled?: boolean }> = ({ label, options, value, onChange, help, disabled = false }) => (
  <Field label={label} help={help}>
    <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </Field>
);
const Input: React.FC<Usermod.ReactInputProps> = ({ label, value, onChange, type = "text", placeholder, min, max, step, help, disabled = false }) => (
  <Field label={label} help={help}>
    <input type={type} value={value} placeholder={placeholder} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  </Field>
);
const Mono: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className }) => <div className={cx("usermod-mono", className)}>{children}</div>;
const Err: React.FC<{ children?: React.ReactNode }> = ({ children }) => <div className="usermod-err">{children}</div>;
const Loading: React.FC<{ text?: string }> = ({ text = "Loading…" }) => <div className="usermod-sub">{text}</div>;

const SettingsForm: React.FC<{ modName: string } & Usermod.SettingsFormOptions> = ({ modName, title, fields, reloadPostprocessors = true, onSaved }) => {
  const { data: info, error } = useInfo();
  const [values, setValues] = React.useState<Record<string, unknown> | null>(null);
  React.useEffect(() => {
    if (info) setValues({ ...(info.config.settings[modName] ?? {}) });
  }, [info, modName]);
  if (error) return <Err>{error}</Err>;
  if (!values) return <Loading />;
  const set = (key: string, value: unknown): void => setValues((prev) => ({ ...(prev ?? {}), [key]: value }));
  const control = (f: Usermod.SettingsField): React.ReactNode => {
    const current = values[f.key];
    switch (f.type) {
      case "boolean":
        return <Toggle key={f.key} label={f.label} checked={Boolean(current)} onChange={(v) => set(f.key, v)} help={f.help} />;
      case "select":
        return <Select key={f.key} label={f.label} options={f.options ?? []} value={String(current ?? f.options?.[0]?.value ?? "")} onChange={(v) => set(f.key, v)} help={f.help} />;
      case "number":
        return <Input key={f.key} type="number" label={f.label} value={current == null ? "" : String(current)} placeholder={f.placeholder} min={f.min} max={f.max} step={f.step} help={f.help} onChange={(v) => set(f.key, v === "" ? (f.nullable ? null : 0) : Number(v))} />;
      default:
        return <Input key={f.key} type="text" label={f.label} value={current == null ? "" : String(current)} placeholder={f.placeholder} help={f.help} onChange={(v) => set(f.key, v === "" && f.nullable ? null : v)} />;
    }
  };
  const save = async (): Promise<void> => {
    const r = await window.usermod.setSettings(modName, values);
    if (!r.ok) throw new Error(r.message);
    if (reloadPostprocessors) await window.usermod.reload();
    rt.toast(`${modName} settings saved`, { kind: "success" });
    await onSaved?.(values);
  };
  return (
    <div className="usermod-settings-form">
      {title ? <h4>{title}</h4> : null}
      {fields.map(control)}
      <Row>
        <Button label="Save" primary onClick={save} />
      </Row>
    </div>
  );
};

export const reactKit: Usermod.ReactKit = {
  version: React.version,
  mount,
  modal,
  ModalFooter,
  popover,
  Section,
  Sub,
  KV,
  List,
  Row,
  Button,
  Toggle,
  Select,
  Input,
  Mono,
  Err,
  Loading,
  SettingsForm,
  useInfo,
  useInvoke,
  useAsync,
  useEvent,
  useMachineState,
  useRoute
};
/** What window.ReactDOM becomes: the classic UMD shape (react-dom + react-dom/client). */
export const ReactDOMGlobal: typeof ReactDOM & typeof ReactDOMClient = { ...ReactDOM, ...ReactDOMClient };
export { React };
