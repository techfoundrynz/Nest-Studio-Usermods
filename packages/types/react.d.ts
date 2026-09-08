/*
 * Types for React UI mods. Add to a mod's tsconfig:
 *   "types": ["@neststudio-usermods/types/renderer", "@neststudio-usermods/types/react"], "jsx": "react"
 * and use the classic UMD globals: `React.useState(...)`, `<div />` (default factory React.createElement).
 * @types/react declares the global `React` namespace for script files; packages/react-runtime provides the
 * matching runtime globals (window.React, window.ReactDOM) plus a small mount helper.
 */
/// <reference types="react" />
/// <reference types="react-dom" />

interface UsermodReactRuntime {
  version: string;
  /** Renders into a container you own (e.g. a kit modal/popover body). Returns an unmount function. */
  mount(container: Element, element: React.ReactNode): () => void;
}

interface Window {
  React: typeof import("react");
  ReactDOM: typeof import("react-dom/client");
  usermodReactRuntime: UsermodReactRuntime;
}
