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

  it("reuses unchanged item nodes while scrolling", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("Missing scroller.");
    }
    const list = createVirtualizedList({
      scroller,
      items: Array.from({ length: 100 }, (_, index) => ({ id: index, label: `Row ${index}` })),
      itemHeight: 20,
      viewportHeight: 100,
      overscan: 1,
      getKey: (item) => item.id,
      renderItem: (item, index) => {
        const row = document.createElement("div");
        row.textContent = `${index}:${item.label}`;
        return row;
      },
    });
    const before = scroller.querySelector(`[data-tachyon-virtual-item="3"]`);
    if (!(before instanceof HTMLElement)) {
      throw new Error("Missing initial row.");
    }

    list.scrollToIndex(3);

    expect(scroller.querySelector(`[data-tachyon-virtual-item="3"]`)).toBe(before);
    list.destroy();
  });

  it("coalesces scroll rendering with requestAnimationFrame", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("Missing scroller.");
    }
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let renderCount = 0;
    const list = createVirtualizedList({
      scroller,
      items: Array.from({ length: 100 }, (_, index) => `Row ${index}`),
      itemHeight: 20,
      viewportHeight: 100,
      overscan: 1,
      renderItem: (item, index) => {
        renderCount++;
        const row = document.createElement("div");
        row.textContent = `${index}:${item}`;
        return row;
      },
    });
    const initialRenderCount = renderCount;

    scroller.scrollTop = 40;
    scroller.dispatchEvent(new Event("scroll"));
    scroller.scrollTop = 60;
    scroller.dispatchEvent(new Event("scroll"));

    expect(frames).toHaveLength(1);
    expect(renderCount).toBe(initialRenderCount);
    frames.shift()?.(0);
    expect(scroller.textContent).toContain("2:Row 2");
    list.destroy();
  });

  it("skips DOM replacement when the virtual window range is unchanged", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("Missing scroller.");
    }
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const list = createVirtualizedList({
      scroller,
      items: Array.from({ length: 100 }, (_, index) => `Row ${index}`),
      itemHeight: 20,
      viewportHeight: 100,
      overscan: 1,
      renderItem: (item, index) => {
        const row = document.createElement("div");
        row.textContent = `${index}:${item}`;
        return row;
      },
    });
    const windowEl = scroller.firstElementChild?.firstElementChild;
    if (!(windowEl instanceof HTMLElement)) {
      throw new Error("Missing virtual window.");
    }
    const replaceChildren = vi.spyOn(windowEl, "replaceChildren");

    scroller.scrollTop = 1;
    scroller.dispatchEvent(new Event("scroll"));
    frames.shift()?.(0);

    expect(replaceChildren).not.toHaveBeenCalled();
    list.destroy();
  });
});
