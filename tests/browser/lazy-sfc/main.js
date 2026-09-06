// Browser entry for the Vite-built lazy hydration fixture. The SFC setup and
// the boundary bindings are produced by the real compiler and Vite plugin.
import { hydrate } from "./lazy.td";

const root = document.querySelector("#generated-lazy");
if (!(root instanceof HTMLElement)) throw new Error("Missing generated lazy root.");
window.__lazyStop = hydrate(root, root);
window.__lazyReady = true;
