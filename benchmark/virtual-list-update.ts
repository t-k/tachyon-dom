import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { createVirtualizedList } from "../src/runtime/virtual-list";

const dom = new JSDOM(`<div id="scroller"></div>`);
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
});
const scroller = document.querySelector("#scroller");
if (!(scroller instanceof HTMLElement)) throw new Error("Missing benchmark scroller.");
let renderCalls = 0;
let updateCalls = 0;
const items = Array.from({ length: 10_000 }, (_, id) => ({ id, label: `Row ${id}` }));
const list = createVirtualizedList({
  scroller,
  items,
  itemHeight: 20,
  viewportHeight: 400,
  getKey: (item) => item.id,
  renderItem: (item) => {
    renderCalls++;
    const row = document.createElement("div");
    row.textContent = item.label;
    return row;
  },
  updateItem: (element, item) => {
    updateCalls++;
    element.textContent = item.label;
  },
});
const started = performance.now();
for (let iteration = 0; iteration < 100; iteration++) {
  list.update(items.map((item) => ({ ...item })));
}
console.log(
  JSON.stringify({
    node: process.version,
    items: items.length,
    updates: 100,
    renderCalls,
    updateCalls,
    durationMs: performance.now() - started,
  }),
);
list.destroy();
dom.window.close();
