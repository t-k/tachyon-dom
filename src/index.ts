import { err, ok, type Result } from "neverthrow";

export type RowKey = number | string;

export type ChunkedRowListOptions<T> = {
  table: HTMLTableElement;
  tbody: HTMLTableSectionElement;
  rowTemplate: HTMLTemplateElement;
  bindRow: (row: HTMLTableRowElement, item: T, index: number) => void;
  updateRow?: (row: HTMLTableRowElement, item: T, index: number) => void;
  selectedClass?: string;
  chunkSize?: number;
};

export type ChunkedRowList<T> = {
  replace: (items: readonly T[]) => void;
  append: (items: readonly T[]) => void;
  updateEvery: (step: number, updateItem: (item: T, index: number) => void) => void;
  selectIndex: (index: number) => void;
  removeIndex: (index: number) => void;
  swap: (a: number, b: number) => void;
  clear: () => void;
  rowAt: (index: number) => HTMLTableRowElement | undefined;
  itemAt: (index: number) => T | undefined;
  selectedIndex: () => number;
  length: () => number;
};

export type ChunkedRowListError = { type: "empty-template" } | { type: "non-row-template"; nodeName: string };

const defaultChunkSize = 50;

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

export const createChunkedRowList = <T>(
  options: ChunkedRowListOptions<T>,
): Result<ChunkedRowList<T>, ChunkedRowListError> => {
  const templateRowResult = getFirstTemplateRow(options.rowTemplate);
  if (templateRowResult.isErr()) {
    return err(templateRowResult.error);
  }

  const bindRow = options.bindRow;
  const updateRow = options.updateRow ?? bindRow;
  const selectedClass = options.selectedClass ?? "danger";
  const chunkSize = options.chunkSize ?? defaultChunkSize;
  const templateRow = templateRowResult.value;
  const chunkCache = new Map<number, DocumentFragment>();
  const items: T[] = [];
  let selected = -1;

  const rows = () => options.tbody.rows;

  const chunkFor = (size: number): DocumentFragment => {
    let chunk = chunkCache.get(size);
    if (!chunk) {
      chunk = buildTemplateChunk(templateRow, size);
      chunkCache.set(size, chunk);
    }
    return chunk;
  };

  const appendInternal = (nextItems: readonly T[]): void => {
    for (let offset = 0; offset < nextItems.length; offset += chunkSize) {
      const size = Math.min(chunkSize, nextItems.length - offset);
      const chunk = chunkFor(size);
      const children = chunk.children;
      for (let localIndex = 0; localIndex < size; localIndex++) {
        bindRow(
          children[localIndex] as HTMLTableRowElement,
          nextItems[offset + localIndex] as T,
          items.length + offset + localIndex,
        );
      }
      options.tbody.appendChild(chunk.cloneNode(true));
    }
    items.push(...nextItems);
  };

  const clear = (): void => {
    items.length = 0;
    selected = -1;
    options.tbody.textContent = "";
  };

  const replace = (nextItems: readonly T[]): void => {
    const reattach = reattachAfterBulkMutation(options.tbody);
    clear();
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

  const updateEvery = (step: number, updateItem: (item: T, index: number) => void): void => {
    const liveRows = rows();
    for (let index = 0; index < items.length; index += step) {
      const item = items[index] as T;
      updateItem(item, index);
      updateRow(liveRows[index] as HTMLTableRowElement, item, index);
    }
  };

  const selectIndex = (index: number): void => {
    const liveRows = rows();
    if (index < 0 || index >= liveRows.length || selected === index) {
      return;
    }
    if (selected > -1) {
      (liveRows[selected] as HTMLTableRowElement).className = "";
    }
    selected = index;
    (liveRows[index] as HTMLTableRowElement).className = selectedClass;
  };

  const removeIndex = (index: number): void => {
    const row = rows()[index];
    if (!row) {
      return;
    }
    row.remove();
    items.splice(index, 1);
    if (selected === index) {
      selected = -1;
    } else if (selected > index) {
      selected--;
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

    const liveRows = rows();
    const rowA = liveRows[a] as HTMLTableRowElement;
    const rowB = liveRows[b] as HTMLTableRowElement;
    const nextA = rowA.nextSibling;
    const nextB = rowB.nextSibling;

    if (nextA === rowB) {
      options.tbody.insertBefore(rowB, rowA);
    } else {
      options.tbody.insertBefore(rowB, nextA);
      options.tbody.insertBefore(rowA, nextB);
    }

    swapIndexes(items, a, b);
    if (selected === a) {
      selected = b;
    } else if (selected === b) {
      selected = a;
    }
  };

  return ok({
    replace,
    append,
    updateEvery,
    selectIndex,
    removeIndex,
    swap,
    clear,
    rowAt: (index) => rows()[index],
    itemAt: (index) => items[index],
    selectedIndex: () => selected,
    length: () => items.length,
  });
};

export const textAt = (root: Node, path: readonly number[]): Text => {
  let current: Node = root;
  for (const index of path) {
    current = current.childNodes[index] as Node;
  }
  return current as Text;
};
