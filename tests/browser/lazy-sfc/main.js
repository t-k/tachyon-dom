// Browser entry for the Vite-built lazy hydration fixture. The SFC setup and
// the boundary bindings are produced by the real compiler and Vite plugin. The
// hydrate-only module keeps boundary-only runtime out of the static graph.
import { hydrate } from "./lazy.td?client&hydrate-only";

const root = document.querySelector("#generated-lazy");
if (!(root instanceof HTMLElement)) throw new Error("Missing generated lazy root.");
window.__lazyStop = hydrate(root, root);
window.__lazyReady = true;
