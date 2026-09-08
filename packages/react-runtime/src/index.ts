/*
 * React runtime for UI mods. Bundled by esbuild into dist/react-runtime.js (an IIFE) and injected by the
 * loader after the UI kit. Exposes the classic UMD-style globals `React` and `ReactDOM` (client API), so a
 * mod compiled with "jsx": "react" needs nothing else, plus usermodReactRuntime.mount() for root handling.
 * This is a separate copy of React from the app's own; never mount into DOM the app's React owns.
 */
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";

interface UsermodReactRuntime {
  version: string;
  mount(container: Element, element: React.ReactNode): () => void;
}

const roots = new WeakMap<Element, ReactDOMClient.Root>();
const runtime: UsermodReactRuntime = {
  version: React.version,
  mount(container, element) {
    let root = roots.get(container);
    if (!root) {
      root = ReactDOMClient.createRoot(container);
      roots.set(container, root);
    }
    root.render(element);
    return () => {
      roots.get(container)?.unmount();
      roots.delete(container);
    };
  }
};

declare global {
  interface Window {
    React: typeof React;
    ReactDOM: typeof ReactDOMClient;
    usermodReactRuntime: UsermodReactRuntime;
  }
}

if (!window.React) {
  window.React = React;
  window.ReactDOM = ReactDOMClient;
}
window.usermodReactRuntime = runtime;
console.log("[usermod] react runtime ready", React.version);
