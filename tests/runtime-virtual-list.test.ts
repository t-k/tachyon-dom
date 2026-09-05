import { afterEach, describe, expect, it, vi } from "vitest";
import { createVirtualizedList, type VirtualizedList } from "../src/runtime/virtual-list";

describe("virtualized list runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid geometry before mounting a virtual list", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    const options = {
      scroller,
      items: ["row"],
      viewportHeight: 20,
      renderItem: () => document.createElement("div"),
    };

    for (const itemHeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createVirtualizedList({ ...options, itemHeight })).toThrow("itemHeight");
    }
  });

  it("keeps the original DOM and listeners untouched for an invalid viewport", () => {
    document.body.innerHTML = `<div id="scroller"><p>original</p></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    let viewportHeight = Number.NaN;
    let renders = 0;

    expect(() =>
      createVirtualizedList({
        scroller,
        items: ["row"],
        itemHeight: 20,
        viewportHeight: () => viewportHeight,
        renderItem: () => {
          renders++;
          return document.createElement("div");
        },
      }),
    ).toThrow("viewportHeight");

    viewportHeight = 20;
    scroller.dispatchEvent(new Event("scroll"));

    expect(scroller.innerHTML).toBe(`<p>original</p>`);
    expect(renders).toBe(0);
  });

  it("cleans rows created before a later virtual row fails", () => {
    document.body.innerHTML = `<div id="scroller"><p>original</p></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    const disposed: number[] = [];
    let renders = 0;

    expect(() =>
      createVirtualizedList({
        scroller,
        items: [0, 1],
        itemHeight: 20,
        viewportHeight: 100,
        renderItem: (item) => {
          renders++;
          if (item === 1) throw new Error("virtual row failed");
          return { element: document.createElement("div"), dispose: () => disposed.push(item) };
        },
      }),
    ).toThrow("virtual row failed");

    scroller.dispatchEvent(new Event("scroll"));

    expect(scroller.innerHTML).toBe(`<p>original</p>`);
    expect(disposed).toEqual([0]);
    expect(renders).toBe(2);
  });

  it("keeps keyed elements and refreshes their content on update", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    const list = createVirtualizedList({
      scroller,
      items: [{ id: "a", label: "A" }],
      itemHeight: 24,
      viewportHeight: 48,
      getKey: (item) => item.id,
      renderItem: (item) => {
        const row = document.createElement("button");
        row.textContent = item.label;
        return row;
      },
      updateItem: (element, item) => {
        element.textContent = item.label;
      },
    });
    const before = scroller.querySelector("button");

    list.update([{ id: "a", label: "B" }]);

    expect(scroller.querySelector("button")).toBe(before);
    expect(before?.textContent).toBe("B");
    list.destroy();
  });

  it("rolls back items when rendering a virtual-list update fails", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    let fail = true;
    let attemptedItemOne = false;
    const list = createVirtualizedList({
      scroller,
      items: [0],
      itemHeight: 20,
      viewportHeight: 40,
      overscan: 0,
      renderItem: (item) => {
        if (item === 1) {
          attemptedItemOne = true;
          if (fail) throw new Error("virtual update failed");
        }
        const element = document.createElement("div");
        element.textContent = String(item);
        return element;
      },
    });

    expect(() => list.update([0, 1])).toThrow("virtual update failed");
    attemptedItemOne = false;
    list.scrollToIndex(1);

    expect(attemptedItemOne).toBe(false);
    expect(scroller.textContent).toBe("0");
    fail = false;
    list.update([0, 1]);
    expect(scroller.textContent).toBe("01");
    list.destroy();
  });

  it("disposes rows that leave the window and makes destroy idempotent", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    const disposed: string[] = [];
    const list = createVirtualizedList({
      scroller,
      items: [{ id: "a" }, { id: "b" }],
      itemHeight: 20,
      viewportHeight: 20,
      overscan: 0,
      getKey: (item) => item.id,
      renderItem: (item) => ({
        element: document.createElement("div"),
        dispose: () => disposed.push(item.id),
      }),
    });

    list.update([{ id: "b" }]);
    list.destroy();
    list.destroy();
    list.update([{ id: "c" }]);

    expect(disposed).toEqual(["a", "b"]);
    expect(scroller.childElementCount).toBe(0);
  });

  it("does not dispose an exiting row twice when its disposer destroys the list", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    const disposed: string[] = [];
    let list: VirtualizedList<{ id: string }> | undefined;
    list = createVirtualizedList({
      scroller,
      items: [{ id: "a" }],
      itemHeight: 20,
      viewportHeight: 20,
      overscan: 0,
      getKey: (item) => item.id,
      renderItem: (item) => ({
        element: document.createElement("div"),
        dispose: () => {
          disposed.push(item.id);
          list?.destroy();
        },
      }),
    });

    list.update([]);

    expect(disposed).toEqual(["a"]);
    expect(scroller.childElementCount).toBe(0);
  });

  it("keeps the committed item generation after an exiting-row cleanup error", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    const list = createVirtualizedList({
      scroller,
      items: [{ id: 0 }],
      itemHeight: 20,
      viewportHeight: 20,
      overscan: 0,
      getKey: (item) => item.id,
      renderItem: (item) => ({
        element: Object.assign(document.createElement("div"), { textContent: String(item.id) }),
        dispose: () => {
          if (item.id === 0) throw new Error("row cleanup failed");
        },
      }),
    });

    expect(() => list.update([{ id: 1 }, { id: 2 }])).toThrow("row cleanup failed");
    expect(scroller.textContent).toBe("1");

    list.scrollToIndex(1);

    expect(scroller.textContent).toBe("2");
    list.destroy();
  });

  it("renders only added keys and removes missing keys on update", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    let renders = 0;
    const list = createVirtualizedList({
      scroller,
      items: [{ id: "a" }, { id: "b" }],
      itemHeight: 20,
      viewportHeight: 100,
      getKey: (item) => item.id,
      renderItem: (item) => {
        renders++;
        const row = document.createElement("div");
        row.textContent = item.id;
        return row;
      },
    });
    const retained = scroller.querySelector(`[data-tachyon-virtual-item="b"]`);

    list.update([{ id: "b" }, { id: "c" }]);

    expect(renders).toBe(3);
    expect(scroller.querySelector(`[data-tachyon-virtual-item="a"]`)).toBeNull();
    expect(scroller.querySelector(`[data-tachyon-virtual-item="b"]`)).toBe(retained);
    expect(scroller.textContent).toBe("bc");
    list.destroy();
  });

  it("preserves focused input state for unchanged keys", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    const list = createVirtualizedList({
      scroller,
      items: [{ id: "a" }],
      itemHeight: 20,
      viewportHeight: 100,
      getKey: (item) => item.id,
      renderItem: () => document.createElement("input"),
    });
    const input = scroller.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing input.");
    input.value = "draft";
    input.focus();

    list.update([{ id: "a" }]);

    expect(scroller.querySelector("input")).toBe(input);
    expect(input.value).toBe("draft");
    expect(document.activeElement).toBe(input);
    list.destroy();
  });

  it("rejects duplicate keys before replacing the current window", () => {
    document.body.innerHTML = `<div id="scroller"></div>`;
    const scroller = document.querySelector("#scroller");
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing scroller.");
    const list = createVirtualizedList({
      scroller,
      items: [{ id: "a" }],
      itemHeight: 20,
      viewportHeight: 100,
      getKey: (item) => item.id,
      renderItem: (item) => {
        const row = document.createElement("div");
        row.textContent = item.id;
        return row;
      },
    });

    expect(() => list.update([{ id: "a" }, { id: "a" }])).toThrow("Duplicate virtual list key: a");
    expect(scroller.textContent).toBe("a");
    list.destroy();
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
