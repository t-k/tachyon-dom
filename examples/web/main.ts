import "./styles.css";
import * as appModule from "./app.td";

export const mountWebExample = (appModule as unknown as { mountWebExample: (app: HTMLElement) => Promise<void> })
  .mountWebExample;

const app = document.querySelector("#app");
if (app instanceof HTMLElement) {
  void mountWebExample(app);
}
