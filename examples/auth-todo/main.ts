import "./styles.css";
import * as appModule from "./app.td";

export const mountAuthTodoExample = (
  appModule as unknown as { mountAuthTodoExample: (app: HTMLElement) => () => void }
).mountAuthTodoExample;

const app = document.querySelector("#app");
if (app instanceof HTMLElement) {
  mountAuthTodoExample(app);
}
