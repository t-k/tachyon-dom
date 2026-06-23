import { err, ok, type Result } from "../result";

export type RowKey = number | string;

export type ChunkedRowListOptions<T> = {
  table?: HTMLTableElement;
  tbody: HTMLTableSectionElement;
  rowTemplate: HTMLTemplateElement;
  bindRow: (row: HTMLTableRowElement, item: T, index: number) => void;
  updateRow?: (row: HTMLTableRowElement, item: T, index: number) => void;
  selectedClass?: string;
  chunkSize?: number;
  /**
   * Bind cached template chunks before cloning them into the live table.
   * Only DOM state preserved by cloneNode, such as text, attributes, and classes,
   * is copied. Event listeners and expando properties are intentionally not copied.
   */
  cloneBoundRows?: boolean;
};

export type ChunkedRowList<T> = {
  replace: (items: readonly T[]) => void;
  append: (items: readonly T[]) => void;
  replaceGenerated: (count: number, createItem: (index: number) => T) => void;
  appendGenerated: (count: number, createItem: (index: number) => T) => void;
  updateEvery: (step: number, updateItem: (item: T, index: number) => void) => void;
  mapEvery: (step: number, mapItem: (item: T, index: number) => T) => void;
  patchEvery: (
    step: number,
    patchItem: (row: HTMLTableRowElement, item: T, index: number) => T | undefined | void,
  ) => void;
  selectIndex: (index: number) => void;
  selectRow: (row: HTMLTableRowElement) => void;
  removeIndex: (index: number) => void;
  swap: (a: number, b: number) => void;
  clear: () => void;
  rowAt: (index: number) => HTMLTableRowElement | undefined;
  itemAt: (index: number) => T | undefined;
  selectedIndex: () => number;
  length: () => number;
};

export type ChunkedRowListError = { type: "empty-template" } | { type: "non-row-template"; nodeName: string };

const defaultChunkSize = 25;

const getFirstTemplateRow = (template: HTMLTemplateElement): Result<HTMLTableRowElement, ChunkedRowListError> => {
  const first = template.content.firstElementChild;
  if (!first) {
    return err({ type: "empty-template" });
  }
  if (!(first instanceof HTMLTableRowElement)) {
    return err({ type: "non-row-template", nodeName: first.nodeName });
  }
  return ok(first);
};

const buildTemplateChunk = (baseRow: HTMLTableRowElement, size: number): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < size; i++) {
    fragment.appendChild(baseRow.cloneNode(true));
  }
  return fragment;
};

const reattachAfterBulkMutation = (tbody: HTMLTableSectionElement): (() => void) => {
  const parent = tbody.parentNode;
  const nextSibling = tbody.nextSibling;
  if (!parent) {
    return () => undefined;
  }
  parent.removeChild(tbody);
  return () => {
    parent.insertBefore(tbody, nextSibling);
  };
};

const swapIndexes = <T>(items: T[], a: number, b: number): void => {
  const tmp = items[a];
  items[a] = items[b] as T;
  items[b] = tmp as T;
};

const removeAt = <T>(items: T[], index: number): void => {
  for (let next = index + 1; next < items.length; next++) {
    items[next - 1] = items[next] as T;
  }
  items.length--;
};

export const createChunkedRowList = <T>(
  options: ChunkedRowListOptions<T>,
): Result<ChunkedRowList<T>, ChunkedRowListError> => {
  const templateRowResult = getFirstTemplateRow(options.rowTemplate);
  if (!templateRowResult.ok) {
    return err(templateRowResult.error);
  }

  const bindRow = options.bindRow;
  const updateRow = options.updateRow ?? bindRow;
  const selectedClass = options.selectedClass ?? "danger";
  const chunkSize = options.chunkSize ?? defaultChunkSize;
  const cloneBoundRows = options.cloneBoundRows === true;
  const templateRow = templateRowResult.value;
  const chunkCache = new Map<number, DocumentFragment>();
  const items: T[] = [];
  const rowNodes: HTMLTableRowElement[] = [];
  const rowPool: HTMLTableRowElement[] = [];
  let selectedRow: HTMLTableRowElement | undefined;

  const chunkFor = (size: number): DocumentFragment => {
    let chunk = chunkCache.get(size);
    if (!chunk) {
      chunk = buildTemplateChunk(templateRow, size);
      chunkCache.set(size, chunk);
    }
    return chunk;
  };

  const appendCloneBoundChunk = (start: number, offset: number, size: number, createItem: (index: number) => T): void => {
    const templateChunk = chunkFor(size);
    const templateChildren = templateChunk.children;
    for (let localIndex = 0; localIndex < size; localIndex++) {
      const index = start + offset + localIndex;
      const item = createItem(index);
      items[index] = item;
      bindRow(templateChildren[localIndex] as HTMLTableRowElement, item, index);
    }

    const fragment = templateChunk.cloneNode(true) as DocumentFragment;
    const children = fragment.children;
    for (let localIndex = 0; localIndex < size; localIndex++) {
      const index = start + offset + localIndex;
      const row = children[localIndex] as HTMLTableRowElement;
      rowNodes[index] = row;
    }
    options.tbody.appendChild(fragment);
  };

  const appendInternal = (nextItems: readonly T[]): void => {
    const start = items.length;
    items.length = start + nextItems.length;
    for (let offset = 0; offset < nextItems.length; offset += chunkSize) {
      const size = Math.min(chunkSize, nextItems.length - offset);
      const usePool = rowPool.length >= size;
      if (cloneBoundRows && !usePool) {
        appendCloneBoundChunk(start, offset, size, (index) => nextItems[index - start] as T);
        continue;
      }
      const fragment = usePool ? document.createDocumentFragment() : (chunkFor(size).cloneNode(true) as DocumentFragment);
      const children = fragment.children;
      for (let localIndex = 0; localIndex < size; localIndex++) {
        const index = start + offset + localIndex;
        const item = nextItems[offset + localIndex] as T;
        const row = usePool ? (rowPool.pop() as HTMLTableRowElement) : (children[localIndex] as HTMLTableRowElement);
        items[index] = item;
        rowNodes[index] = row;
        bindRow(row, item, index);
        if (usePool) {
          fragment.appendChild(row);
        }
      }
      options.tbody.appendChild(fragment);
    }
  };

  const appendGeneratedInternal = (count: number, createItem: (index: number) => T): void => {
    if (count <= 0) {
      return;
    }
    const start = items.length;
    items.length = start + count;
    for (let offset = 0; offset < count; offset += chunkSize) {
      const size = Math.min(chunkSize, count - offset);
      const usePool = rowPool.length >= size;
      if (cloneBoundRows && !usePool) {
        appendCloneBoundChunk(start, offset, size, createItem);
        continue;
      }
      const fragment = usePool ? document.createDocumentFragment() : (chunkFor(size).cloneNode(true) as DocumentFragment);
      const children = fragment.children;
      for (let localIndex = 0; localIndex < size; localIndex++) {
        const index = start + offset + localIndex;
        const item = createItem(index);
        const row = usePool ? (rowPool.pop() as HTMLTableRowElement) : (children[localIndex] as HTMLTableRowElement);
        items[index] = item;
        rowNodes[index] = row;
        bindRow(row, item, index);
        if (usePool) {
          fragment.appendChild(row);
        }
      }
      options.tbody.appendChild(fragment);
    }
  };

  const clearInternal = (clearCachedChunks: boolean): void => {
    if (clearCachedChunks) {
      rowPool.length = 0;
    } else {
      for (let index = rowNodes.length - 1; index >= 0; index--) {
        const row = rowNodes[index] as HTMLTableRowElement;
        row.className = "";
        rowPool.push(row);
      }
    }
    items.length = 0;
    rowNodes.length = 0;
    selectedRow = undefined;
    if (clearCachedChunks) {
      chunkCache.clear();
    }
    options.tbody.textContent = "";
  };

  const clear = (): void => clearInternal(true);

  const replace = (nextItems: readonly T[]): void => {
    const reattach = reattachAfterBulkMutation(options.tbody);
    clearInternal(false);
    appendInternal(nextItems);
    reattach();
  };

  const append = (nextItems: readonly T[]): void => {
    if (items.length === 0 && nextItems.length > 0 && options.tbody.parentNode) {
      const reattach = reattachAfterBulkMutation(options.tbody);
      appendInternal(nextItems);
      reattach();
      return;
    }
    appendInternal(nextItems);
  };

  const replaceGenerated = (count: number, createItem: (index: number) => T): void => {
    const reattach = reattachAfterBulkMutation(options.tbody);
    clearInternal(false);
    appendGeneratedInternal(count, createItem);
    reattach();
  };

  const appendGenerated = (count: number, createItem: (index: number) => T): void => {
    if (items.length === 0 && count > 0 && options.tbody.parentNode) {
      const reattach = reattachAfterBulkMutation(options.tbody);
      appendGeneratedInternal(count, createItem);
      reattach();
      return;
    }
    appendGeneratedInternal(count, createItem);
  };

  const updateEvery = (step: number, updateItem: (item: T, index: number) => void): void => {
    for (let index = 0; index < items.length; index += step) {
      const item = items[index] as T;
      updateItem(item, index);
      updateRow(rowNodes[index] as HTMLTableRowElement, item, index);
    }
  };

  const mapEvery = (step: number, mapItem: (item: T, index: number) => T): void => {
    for (let index = 0; index < items.length; index += step) {
      const item = mapItem(items[index] as T, index);
      items[index] = item;
      updateRow(rowNodes[index] as HTMLTableRowElement, item, index);
    }
  };

  const patchEvery = (
    step: number,
    patchItem: (row: HTMLTableRowElement, item: T, index: number) => T | undefined | void,
  ): void => {
    for (let index = 0; index < items.length; index += step) {
      const item = items[index] as T;
      const nextItem = patchItem(rowNodes[index] as HTMLTableRowElement, item, index);
      if (nextItem !== undefined) {
        items[index] = nextItem;
      }
    }
  };

  const selectIndex = (index: number): void => {
    const row = rowNodes[index];
    if (!row || selectedRow === row) {
      return;
    }
    if (selectedRow) {
      selectedRow.className = "";
    }
    selectedRow = row;
    row.className = selectedClass;
  };

  const selectRow = (row: HTMLTableRowElement): void => {
    if (row.parentNode !== options.tbody) {
      return;
    }
    if (selectedRow === row) {
      return;
    }
    if (selectedRow) {
      selectedRow.className = "";
    }
    selectedRow = row;
    row.className = selectedClass;
  };

  const removeIndex = (index: number): void => {
    const row = rowNodes[index];
    if (!row) {
      return;
    }
    row.remove();
    removeAt(items, index);
    removeAt(rowNodes, index);
    if (selectedRow === row) {
      selectedRow = undefined;
    }
  };

  const swap = (a: number, b: number): void => {
    if (a === b || a < 0 || b < 0 || a >= items.length || b >= items.length) {
      return;
    }
    if (a > b) {
      swap(b, a);
      return;
    }

    const rowA = rowNodes[a] as HTMLTableRowElement;
    const rowB = rowNodes[b] as HTMLTableRowElement;
    const nextA = rowA.nextSibling;
    const nextB = rowB.nextSibling;

    if (nextA === rowB) {
      options.tbody.insertBefore(rowB, rowA);
    } else {
      options.tbody.insertBefore(rowB, nextA);
      options.tbody.insertBefore(rowA, nextB);
    }

    swapIndexes(items, a, b);
    swapIndexes(rowNodes, a, b);
  };

  return ok({
    replace,
    append,
    replaceGenerated,
    appendGenerated,
    updateEvery,
    mapEvery,
    patchEvery,
    selectIndex,
    selectRow,
    removeIndex,
    swap,
    clear,
    rowAt: (index) => rowNodes[index],
    itemAt: (index) => items[index],
    selectedIndex: () => (selectedRow?.parentNode === options.tbody ? selectedRow.sectionRowIndex : -1),
    length: () => items.length,
  });
};
