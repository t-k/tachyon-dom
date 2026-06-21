import "./styles.css";
import * as appModule from "./app-client.td";
import type { ClientRouter } from "../../src/runtime/router";

export const mountFullAppExample = (
  appModule as unknown as {
    mountFullAppExample: (root: HTMLElement) => Promise<{ router: ClientRouter; dispose: () => void }>;
  }
).mountFullAppExample;

if (typeof document !== "undefined") {
  const app = document.querySelector("#app");
  if (app instanceof HTMLElement) {
    void mountFullAppExample(app);
  }
}
