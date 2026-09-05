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

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

type RenderedRow = {
  element: Element;
  dispose: (() => void) | undefined;
};

type CleanupOutcome = { failed: false } | { failed: true; error: unknown };

const elementAndDisposer = (value: VirtualizedListItem): RenderedRow => {
  if (value instanceof Element) {
    return { element: value, dispose: undefined };
  }
  if (value && value.element instanceof Element) {
    let disposed = false;
    return {
      element: value.element,
      dispose: value.dispose
        ? () => {
            if (disposed) return;
            disposed = true;
            value.dispose?.();
          }
        : undefined,
    };
  }
  throw new TypeError("Virtual list renderItem must return an Element or a view handle.");
};

export const createVirtualizedList = <T>(options: VirtualizedListOptions<T>): VirtualizedList<T> => {
  const { scroller, itemHeight, renderItem, updateItem, getKey, viewportHeight: viewportHeightOption } = options;
  const overscan = options.overscan ?? 3;
  if (!Number.isFinite(itemHeight) || itemHeight <= 0) {
    throw new RangeError("Virtual list itemHeight must be a finite number greater than zero.");
  }
  if (!Number.isInteger(overscan) || overscan < 0) {
    throw new RangeError("Virtual list overscan must be a non-negative integer.");
  }
  const viewportHeightForList = (): number =>
    typeof viewportHeightOption === "function"
      ? viewportHeightOption()
      : (viewportHeightOption ?? scroller.clientHeight);
  const validateViewportHeight = (viewportHeight: number): number => {
    if (!Number.isFinite(viewportHeight) || viewportHeight < 0) {
      throw new RangeError("Virtual list viewportHeight must be a finite non-negative number.");
    }
    return viewportHeight;
  };
  const validateItems = (nextItems: readonly T[]): T[] => {
    const copy = [...nextItems];
    if (!getKey) return copy;
    const keys = new Set<PropertyKey>();
    for (let index = 0; index < copy.length; index++) {
      const key = normalizeListKey(getKey(copy[index] as T, index));
      if (keys.has(key)) throw new Error(`Duplicate virtual list key: ${String(key)}`);
      keys.add(key);
    }
    return copy;
  };
  const initialViewportHeight = validateViewportHeight(viewportHeightForList());
  const previousChildren = Array.from(scroller.childNodes);
  let items = validateItems(options.items);
  let rendered = new Map<PropertyKey, RenderedRow>();
  let lastRangeKey = "";
  let animationFrame: number | undefined;
  let disposed = false;
  let listenerAttached = false;
  let lastRenderCommitted = false;
  const spacer = document.createElement("div");
  const windowEl = document.createElement("div");
  spacer.style.position = "relative";
  windowEl.style.position = "absolute";
  windowEl.style.insetInline = "0";
  windowEl.style.insetBlockStart = "0";

  const disposeRows = (rows: Iterable<RenderedRow>): CleanupOutcome => {
    let firstError: unknown;
    let failed = false;
    for (const row of rows) {
      try {
        row.dispose?.();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    return failed ? { failed: true, error: firstError } : { failed: false };
  };

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

  const renderWindow = (force = false, measuredViewportHeight?: number): void => {
    lastRenderCommitted = false;
    if (disposed) return;
    const viewportHeight = validateViewportHeight(measuredViewportHeight ?? viewportHeightForList());
    const visibleCount = Math.ceil(viewportHeight / itemHeight);
    const start = clamp(Math.floor(scroller.scrollTop / itemHeight) - overscan, 0, items.length);
    const end = clamp(start + visibleCount + overscan * 2, start, items.length);
    const rangeKey = `${start}:${end}:${items.length}`;
    if (!force && rangeKey === lastRangeKey) {
      return;
    }
    const nextRendered = new Map<PropertyKey, RenderedRow>();
    const nextElements: Element[] = [];
    const createdRows: RenderedRow[] = [];
    try {
      for (let index = start; index < end; index++) {
        const item = items[index] as T;
        const key = getKey ? normalizeListKey(getKey(item, index)) : index;
        const existing = rendered.get(key);
        const row = existing ?? elementAndDisposer(renderItem(item, index));
        if (!existing) createdRows.push(row);
        if (existing) updateItem?.(row.element, item, index);
        const element = row.element;
        element.setAttribute("data-tachyon-virtual-item", String(key));
        element.setAttribute("aria-posinset", String(index + 1));
        element.setAttribute("aria-setsize", String(items.length));
        nextRendered.set(key, row);
        nextElements.push(element);
      }
    } catch (error) {
      const cleanupResult = disposeRows(createdRows);
      for (const row of createdRows) row.element.parentNode?.removeChild(row.element);
      if (cleanupResult.failed) {
        throw new AggregateError([error, cleanupResult.error], "Virtual list render and rollback failed.");
      }
      throw error;
    }
    const previousRendered = rendered;
    const removedRows = Array.from(rendered).flatMap(([key, row]) => (nextRendered.has(key) ? [] : [row]));
    rendered = nextRendered;
    const disposeResult = disposeRows(removedRows);
    if (disposed) {
      if (disposeResult.failed) throw disposeResult.error;
      return;
    }
    try {
      spacer.style.height = `${items.length * itemHeight}px`;
      windowEl.style.transform = `translateY(${start * itemHeight}px)`;
      reconcileWindow(nextElements);
      if (!windowEl.parentNode) {
        spacer.appendChild(windowEl);
      }
      lastRangeKey = rangeKey;
      lastRenderCommitted = true;
    } catch (error) {
      rendered = previousRendered;
      const cleanupResult = disposeRows(createdRows);
      for (const row of createdRows) row.element.parentNode?.removeChild(row.element);
      if (cleanupResult.failed) {
        throw new AggregateError([error, cleanupResult.error], "Virtual list render and rollback failed.");
      }
      throw error;
    }
    if (disposeResult.failed) throw disposeResult.error;
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
  let resizeObserver: ResizeObserver | undefined;
  try {
    renderWindow(false, initialViewportHeight);
    scroller.replaceChildren(spacer);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    listenerAttached = true;
    resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => renderWindow());
    resizeObserver?.observe(scroller);
  } catch (error) {
    if (animationFrame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(animationFrame);
    }
    animationFrame = undefined;
    if (listenerAttached) scroller.removeEventListener("scroll", onScroll);
    resizeObserver?.disconnect();
    const cleanupResult = disposeRows(rendered.values());
    rendered.clear();
    windowEl.replaceChildren();
    scroller.replaceChildren(...previousChildren);
    if (cleanupResult.failed) {
      throw new AggregateError([error, cleanupResult.error], "Virtual list initialization and rollback failed.");
    }
    throw error;
  }

  return {
    update: (nextItems) => {
      if (disposed) return;
      const previousItems = items;
      const previousRangeKey = lastRangeKey;
      items = validateItems(nextItems);
      lastRangeKey = "";
      try {
        renderWindow(true);
      } catch (error) {
        if (!lastRenderCommitted && !disposed) {
          items = previousItems;
          lastRangeKey = previousRangeKey;
        }
        throw error;
      }
    },
    scrollToIndex: (index) => {
      if (disposed) return;
      if (!Number.isInteger(index) || !Number.isFinite(index)) {
        throw new RangeError("Virtual list scrollToIndex must be a finite integer.");
      }
      scroller.scrollTop = clamp(index, 0, Math.max(0, items.length - 1)) * itemHeight;
      renderWindow(true);
    },
    destroy: () => {
      if (disposed) return;
      disposed = true;
      if (animationFrame !== undefined && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(animationFrame);
      }
      animationFrame = undefined;
      if (listenerAttached) scroller.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      const activeRows = Array.from(rendered.values());
      rendered = new Map();
      items = [];
      lastRangeKey = "";
      windowEl.replaceChildren();
      scroller.replaceChildren();
      const disposeResult = disposeRows(activeRows);
      if (disposeResult.failed) throw disposeResult.error;
    },
  };
};
