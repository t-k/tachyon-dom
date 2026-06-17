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
    windowEl.replaceChildren();
    for (let index = start; index < end; index++) {
      const item = items[index] as T;
      const element = options.renderItem(item, index);
      element.setAttribute("data-tachyon-virtual-item", String(options.getKey?.(item, index) ?? index));
      element.setAttribute("aria-posinset", String(index + 1));
      element.setAttribute("aria-setsize", String(items.length));
      windowEl.appendChild(element);
    }
    if (!windowEl.parentNode) {
      spacer.appendChild(windowEl);
    }
  };

  const onScroll = (): void => renderWindow();
  options.scroller.addEventListener("scroll", onScroll, { passive: true });
  renderWindow();

  return {
    update: (nextItems) => {
      items = [...nextItems];
      renderWindow();
    },
    scrollToIndex: (index) => {
      options.scroller.scrollTop = clamp(index, 0, Math.max(0, items.length - 1)) * options.itemHeight;
      renderWindow();
    },
    destroy: () => {
      options.scroller.removeEventListener("scroll", onScroll);
      options.scroller.replaceChildren();
    },
  };
};
