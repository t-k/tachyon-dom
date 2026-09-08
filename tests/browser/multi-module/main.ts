import { hydrate, mount, type MountHandle } from "tachyon-dom/runtime/mount";
import * as CounterA from "./CounterA.td";
import * as CounterB from "./CounterB.td";
import * as SsrPanel from "./SsrPanel.td";
import { events, setShared } from "./shared";

const container = (id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing container: ${id}`);
  return element;
};
const handles = new Map<string, MountHandle>();
handles.set("a1", mount(container("a1"), CounterA));
handles.set("a2", mount(container("a2"), CounterA));
handles.set("b", mount(container("b"), CounterB));
const ssrNode = container("ssr").querySelector("section");
const hydrated = hydrate(container("ssr"), SsrPanel);
if (!hydrated.ok) throw new Error(hydrated.error.message);
handles.set("ssr", hydrated.value);
let oldButton: HTMLElement | null = null;
let oldShared: Element | null = null;
let oldSsr: Element | null = null;

const api = {
  events,
  ssrAdopted: container("ssr").querySelector("section") === ssrNode,
  setShared,
  async loadLazy() {
    const module = await import("./LazyPanel.td");
    handles.set("lazy", mount(container("lazy"), module));
  },
  disposeA1() {
    oldButton = container("a1").querySelector("button");
    oldShared = container("a1").querySelector("[data-shared]");
    handles.get("a1")!.dispose();
  },
  fireOldA1() {
    oldButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return oldShared!.textContent;
  },
  remountA1() {
    handles.set("a1", mount(container("a1"), CounterA));
  },
  disposeSsr() {
    oldSsr = container("ssr").querySelector("section");
    handles.get("ssr")!.dispose();
  },
  fireOldSsr() {
    oldSsr!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return oldSsr!.querySelector("[data-text]")!.textContent;
  },
  remountSsr() {
    handles.set("ssr", mount(container("ssr"), SsrPanel));
  },
  dispose() {
    for (const handle of handles.values()) handle.dispose();
  },
};
Object.assign(window, { multiModule: api });
