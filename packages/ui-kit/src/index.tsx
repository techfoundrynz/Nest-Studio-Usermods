/*
 * Nest Studio user-mod UI kit (window.usermodUI). Injected right after the UI runtime and before any mod.
 *
 * Imperative face (DOM builders the caller owns):
 *   toolbar.addButton()   a button in the app bar right after the Settings gear, styled like it
 *   popover(anchor)       a dropdown panel under an element (the MODS menu is one of these)
 *   modal(), button(), buttonRow(), section(), list(), kv(), toggle(), select(), input()
 *   settingsForm(mod, fields)   edits mods.json "settings.<mod>" through the loader
 *   icons.*               small inline SVGs matching the app's 22 px icon size
 *
 * React face (usermodUI.react): the same building blocks as components, hooks for the loader bridge, and
 * react.modal() / react.popover() / react.mount() to put a React tree into kit containers. React 19 and
 * ReactDOM are bundled in here and published as window.React / window.ReactDOM so mods compiled with
 * "jsx": "react" share this single copy. It is separate from the app's own React: mount only into DOM you own.
 */
import { STYLE } from "./styles";
import { imperative } from "./imperative";
import { reactKit, React, ReactDOMGlobal } from "./react";

(function usermodUiKit(): void {
  if (window.usermodUI) return;
  const rt = window.usermodRuntime;
  rt.addStyle(STYLE, "ui-kit");

  if (window.React && window.React !== React) rt.log("warn", "window.React was already defined; the kit's copy replaces it so TSX mods and kit components share one React");
  window.React = React;
  window.ReactDOM = ReactDOMGlobal;

  const ui: Usermod.UI = { version: "0.4.0", ...imperative, react: reactKit };
  window.usermodUI = ui;
  rt.log("info", `ui kit ready (React ${React.version})`);
})();
