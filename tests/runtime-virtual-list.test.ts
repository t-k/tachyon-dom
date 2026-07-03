import { afterEach, describe, expect, it, vi } from "vitest";
import { createVirtualizedList } from "../src/runtime/virtual-list";

describe("virtualized list runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders only the visible item window and preserves total scroll space", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("Missing scroller.");
    }
    const list = createVirtualizedList({
      scroller,
      items: Array.from({ length: 1000 }, (_, index) => `Row ${index}`),
      itemHeight: 20,
      viewportHeight: 100,
      overscan: 1,
      renderItem: (item, index) => {
        const row = document.createElement("div");
        row.textContent = `${index}:${item}`;
        return row;
      },
    });

    expect(scroller.querySelectorAll("[data-tachyon-virtual-item]").length).toBe(7);
    expect(scroller.textContent).toContain("0:Row 0");
    expect(scroller.textContent).toContain("6:Row 6");
    expect(scroller.firstElementChild?.getAttribute("style")).toContain("height: 20000px");

    list.scrollToIndex(50);

    expect(scroller.textContent).toContain("49:Row 49");
    expect(scroller.textContent).toContain("55:Row 55");
    expect(scroller.textContent).not.toContain("0:Row 0");
    list.destroy();
  });

  it("rerenders the visible window when the scroller is resized", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("Missing scroller.");
    }
    let resize: ResizeObserverCallback | undefined;
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    let viewportHeight = 100;
    const list = createVirtualizedList({
      scroller,
      items: Array.from({ length: 100 }, (_, index) => `Row ${index}`),
      itemHeight: 20,
      viewportHeight: () => viewportHeight,
      overscan: 1,
      renderItem: (item, index) => {
        const row = document.createElement("div");
        row.textContent = `${index}:${item}`;
        return row;
      },
    });

    expect(scroller.querySelectorAll("[data-tachyon-virtual-item]").length).toBe(7);
    viewportHeight = 200;
    resize?.([], {} as ResizeObserver);

    expect(scroller.querySelectorAll("[data-tachyon-virtual-item]").length).toBe(12);
    expect(scroller.textContent).toContain("11:Row 11");
    list.destroy();
  });
});
