import { normalizeListKey } from "./key.js";

export type VirtualizedListItem =
  | Element
  | {
      element: Element;
      dispose?: () => void;
    };

export type VirtualizedListOptions<T> = {
  scroller: HTMLElement;
  items: readonly T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => VirtualizedListItem;
  updateItem?: (element: Element, item: T, index: number) => void;
  getKey?: (item: T, index: number) => PropertyKey;
  viewportHeight?: number | (() => number);
  overscan?: number;
};

export type VirtualizedList<T> = {
  update: (items: readonly T[]) => void;
  scrollToIndex: (index: number) => void;
  destroy: () => void;
};

const viewportHeightFor = <T>(options: VirtualizedListOptions<T>): number => {
  if (typeof options.viewportHeight === "function") {
    return options.viewportHeight();
  }
  return options.viewportHeight ?? options.scroller.clientHeight;
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

type RenderedRow = {
  element: Element;
  dispose: (() => void) | undefined;
};

const elementAndDisposer = (value: VirtualizedListItem): RenderedRow => {
  if (value instanceof Element) {
    return { element: value, dispose: undefined };
  }
  if (value && value.element instanceof Element) {
    return { element: value.element, dispose: value.dispose };
  }
  throw new TypeError("Virtual list renderItem must return an Element or a view handle.");
};

export const createVirtualizedList = <T>(options: VirtualizedListOptions<T>): VirtualizedList<T> => {
  const overscan = options.overscan ?? 3;
  if (!Number.isFinite(options.itemHeight) || options.itemHeight <= 0) {
    throw new RangeError("Virtual list itemHeight must be a finite number greater than zero.");
  }
  if (!Number.isInteger(overscan) || overscan < 0) {
    throw new RangeError("Virtual list overscan must be a non-negative integer.");
  }
  const validateItems = (nextItems: readonly T[]): T[] => {
    const copy = [...nextItems];
    if (!options.getKey) return copy;
    const keys = new Set<PropertyKey>();
    for (let index = 0; index < copy.length; index++) {
      const key = normalizeListKey(options.getKey(copy[index] as T, index));
      if (keys.has(key)) throw new Error(`Duplicate virtual list key: ${String(key)}`);
      keys.add(key);
    }
    return copy;
  };
  let items = validateItems(options.items);
  let rendered = new Map<PropertyKey, RenderedRow>();
  let lastRangeKey = "";
  let animationFrame: number | undefined;
  let disposed = false;
  const spacer = document.createElement("div");
  const windowEl = document.createElement("div");
  spacer.style.position = "relative";
  windowEl.style.position = "absolute";
  windowEl.style.insetInline = "0";
  windowEl.style.insetBlockStart = "0";
  options.scroller.replaceChildren(spacer);

  const reconcileWindow = (elements: readonly Element[]): void => {
    let cursor = windowEl.firstElementChild;
    for (const element of elements) {
      if (element === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        windowEl.insertBefore(element, cursor);
      }
    }
    while (cursor) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  };

  const renderWindow = (force = false): void => {
    if (disposed) return;
    const viewportHeight = viewportHeightFor(options);
    if (!Number.isFinite(viewportHeight) || viewportHeight < 0) {
      throw new RangeError("Virtual list viewportHeight must be a finite non-negative number.");
    }
    const visibleCount = Math.ceil(viewportHeight / options.itemHeight);
    const start = clamp(Math.floor(options.scroller.scrollTop / options.itemHeight) - overscan, 0, items.length);
    const end = clamp(start + visibleCount + overscan * 2, start, items.length);
    const rangeKey = `${start}:${end}:${items.length}`;
    if (!force && rangeKey === lastRangeKey) {
      return;
    }
    lastRangeKey = rangeKey;
    spacer.style.height = `${items.length * options.itemHeight}px`;
    windowEl.style.transform = `translateY(${start * options.itemHeight}px)`;
    const nextRendered = new Map<PropertyKey, RenderedRow>();
    const nextElements: Element[] = [];
    for (let index = start; index < end; index++) {
      const item = items[index] as T;
      const key = options.getKey ? normalizeListKey(options.getKey(item, index)) : index;
      const existing = rendered.get(key);
      const row = existing ?? elementAndDisposer(options.renderItem(item, index));
      if (existing) options.updateItem?.(row.element, item, index);
      const element = row.element;
      element.setAttribute("data-tachyon-virtual-item", String(key));
      element.setAttribute("aria-posinset", String(index + 1));
      element.setAttribute("aria-setsize", String(items.length));
      nextRendered.set(key, row);
      nextElements.push(element);
    }
    let firstDisposeError: unknown;
    let disposeFailed = false;
    for (const [key, row] of rendered) {
      if (nextRendered.has(key)) continue;
      try {
        row.dispose?.();
      } catch (error) {
        if (!disposeFailed) firstDisposeError = error;
        disposeFailed = true;
      }
    }
    rendered = nextRendered;
    reconcileWindow(nextElements);
    if (!windowEl.parentNode) {
      spacer.appendChild(windowEl);
    }
    if (disposeFailed) throw firstDisposeError;
  };

  const scheduleRenderWindow = (): void => {
    if (animationFrame !== undefined) {
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      renderWindow();
      return;
    }
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined;
      renderWindow();
    });
  };

  const onScroll = (): void => scheduleRenderWindow();
  options.scroller.addEventListener("scroll", onScroll, { passive: true });
  const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => renderWindow());
  resizeObserver?.observe(options.scroller);
  renderWindow();

  return {
    update: (nextItems) => {
      if (disposed) return;
      items = validateItems(nextItems);
      lastRangeKey = "";
      renderWindow(true);
    },
    scrollToIndex: (index) => {
      if (disposed) return;
      if (!Number.isInteger(index) || !Number.isFinite(index)) {
        throw new RangeError("Virtual list scrollToIndex must be a finite integer.");
      }
      options.scroller.scrollTop = clamp(index, 0, Math.max(0, items.length - 1)) * options.itemHeight;
      renderWindow(true);
    },
    destroy: () => {
      if (disposed) return;
      disposed = true;
      if (animationFrame !== undefined && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(animationFrame);
      }
      animationFrame = undefined;
      options.scroller.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      let firstDisposeError: unknown;
      let disposeFailed = false;
      for (const row of rendered.values()) {
        try {
          row.dispose?.();
        } catch (error) {
          if (!disposeFailed) firstDisposeError = error;
          disposeFailed = true;
        }
      }
      rendered.clear();
      windowEl.replaceChildren();
      options.scroller.replaceChildren();
      if (disposeFailed) throw firstDisposeError;
    },
  };
};
