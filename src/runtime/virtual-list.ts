export type VirtualizedListOptions<T> = {
  scroller: HTMLElement;
  items: readonly T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => Element;
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

export const createVirtualizedList = <T>(options: VirtualizedListOptions<T>): VirtualizedList<T> => {
  const overscan = options.overscan ?? 3;
  let items = [...options.items];
  let rendered = new Map<PropertyKey, Element>();
  const spacer = document.createElement("div");
  const windowEl = document.createElement("div");
  spacer.style.position = "relative";
  windowEl.style.position = "absolute";
  windowEl.style.insetInline = "0";
  windowEl.style.insetBlockStart = "0";
  options.scroller.replaceChildren(spacer);

  const renderWindow = (): void => {
    const viewportHeight = viewportHeightFor(options);
    const visibleCount = Math.ceil(viewportHeight / options.itemHeight);
    const start = clamp(Math.floor(options.scroller.scrollTop / options.itemHeight) - overscan, 0, items.length);
    const end = clamp(start + visibleCount + overscan * 2, start, items.length);
    spacer.style.height = `${items.length * options.itemHeight}px`;
    windowEl.style.transform = `translateY(${start * options.itemHeight}px)`;
    const nextRendered = new Map<PropertyKey, Element>();
    const nextElements: Element[] = [];
    for (let index = start; index < end; index++) {
      const item = items[index] as T;
      const key = options.getKey?.(item, index) ?? index;
      const element = rendered.get(key) ?? options.renderItem(item, index);
      element.setAttribute("data-tachyon-virtual-item", String(key));
      element.setAttribute("aria-posinset", String(index + 1));
      element.setAttribute("aria-setsize", String(items.length));
      nextRendered.set(key, element);
      nextElements.push(element);
    }
    rendered = nextRendered;
    windowEl.replaceChildren(...nextElements);
    if (!windowEl.parentNode) {
      spacer.appendChild(windowEl);
    }
  };

  const onScroll = (): void => renderWindow();
  options.scroller.addEventListener("scroll", onScroll, { passive: true });
  const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => renderWindow());
  resizeObserver?.observe(options.scroller);
  renderWindow();

  return {
    update: (nextItems) => {
      items = [...nextItems];
      rendered = new Map();
      renderWindow();
    },
    scrollToIndex: (index) => {
      options.scroller.scrollTop = clamp(index, 0, Math.max(0, items.length - 1)) * options.itemHeight;
      renderWindow();
    },
    destroy: () => {
      options.scroller.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      options.scroller.replaceChildren();
    },
  };
};
