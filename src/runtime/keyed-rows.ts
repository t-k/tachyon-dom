/**
 * keyed-rows: a high-performance keyed row list rendered directly into a `<tbody>`.
 *
 * The live DOM is the single source of truth. Unlike a virtual-DOM or shadow-array
 * renderer, this primitive keeps no parallel `items[]` / `rowNodes[]` arrays, so:
 *
 * - memory stays close to the raw element cost (no bookkeeping arrays, no row pool),
 * - `removeAt` / `swap` / `select` are O(1) DOM operations instead of array shifts,
 * - `clear()` simply drops the subtree so it can be garbage collected immediately.
 *
 * Bulk creation binds a reusable multi-row chunk once and clones it, keeping the
 * number of `cloneNode()` / `appendChild()` boundary crossings small and roughly
 * constant regardless of row count. The body is detached during a full rebuild so
 * the browser performs a single layout pass.
 *
 * This module intentionally has no imports: it is the hot path, and keeping it
 * dependency-free keeps both its parse cost and its dev-server module graph minimal.
 */

export type KeyedRowsOptions<T> = {
  /** Table body the rows live in. The DOM beneath it is the source of truth. */
  tbody: HTMLTableSectionElement;
  /** Single-row markup, e.g. `"<tr><td></td>...</tr>"`. Parsed once into a template. */
  row: string;
  /** Write an item's fields into a row before it is cloned into the table. */
  bind: (row: HTMLTableRowElement, item: T, index: number) => void;
  /** Class toggled on the selected row. Defaults to `"selected"`. */
  selectedClass?: string;
  /** Target number of DOM insertions per bulk build. Defaults to `50`. */
  chunks?: number;
};

export type KeyedRows<T> = {
  /** Replace every row from an array of items. */
  replace: (items: readonly T[]) => void;
  /** Append rows from an array of items. */
  append: (items: readonly T[]) => void;
  /** Replace every row, producing each item lazily (no intermediate array). */
  replaceEach: (count: number, make: (index: number) => T) => void;
  /** Append rows, producing each item lazily (no intermediate array). */
  appendEach: (count: number, make: (index: number) => T) => void;
  /** Run `patch` against every `stride`-th live row. */
  update: (stride: number, patch: (row: HTMLTableRowElement, index: number) => void) => void;
  /** Remove the row at `index`. */
  removeAt: (index: number) => void;
  /** Remove a specific row element. */
  removeRow: (row: HTMLTableRowElement) => void;
  /** Swap the rows at `a` and `b`, preserving element identity. */
  swap: (a: number, b: number) => void;
  /** Remove every row. */
  clear: () => void;
  /** Select the row at `index`. */
  selectAt: (index: number) => void;
  /** Select a specific row element, or pass `null` to clear the selection. */
  selectRow: (row: HTMLTableRowElement | null) => void;
  /** Index of the selected row, or `-1`. Recomputed from the live DOM. */
  selectedIndex: () => number;
  /** Number of rows currently in the body. */
  length: () => number;
  /** Row element at `index`, if any. */
  rowAt: (index: number) => HTMLTableRowElement | undefined;
};

type MoveBeforeTableSection = HTMLTableSectionElement & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

const defaultChunks = 50;

const positiveInteger = (name: string, value: number): void => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`keyed-rows: \`${name}\` must be a positive finite integer.`);
  }
};

export const createKeyedRows = <T>(options: KeyedRowsOptions<T>): KeyedRows<T> => {
  const tbody = options.tbody;
  const bind = options.bind;
  const selectedClass = options.selectedClass ?? "selected";
  const targetChunks = options.chunks ?? defaultChunks;
  positiveInteger("chunks", targetChunks);

  const single = document.createElement("template");
  single.innerHTML = options.row;
  const baseRow = single.content.firstElementChild;
  if (!(baseRow instanceof HTMLTableRowElement)) {
    throw new TypeError("keyed-rows: `row` markup must have a single <tr> root.");
  }

  // Reusable chunk of template rows; rebuilt only when the per-chunk size changes.
  const chunk = document.createDocumentFragment();
  let chunkRows = 0;
  let selectedRow: HTMLTableRowElement | undefined;

  const ensureChunk = (rowsPerChunk: number): void => {
    if (chunkRows === rowsPerChunk) {
      return;
    }
    chunk.replaceChildren();
    for (let i = 0; i < rowsPerChunk; i++) {
      chunk.appendChild(baseRow.cloneNode(true));
    }
    chunkRows = rowsPerChunk;
  };

  const build = (count: number, make: (index: number) => T, start: number): void => {
    if (count <= 0) {
      return;
    }
    const perChunk = count < targetChunks ? count : Math.ceil(count / targetChunks);
    ensureChunk(perChunk);
    const templateRows = chunk.children;
    let done = 0;
    while (done < count) {
      const size = Math.min(perChunk, count - done);
      for (let local = 0; local < size; local++) {
        const index = start + done + local;
        bind(templateRows[local] as HTMLTableRowElement, make(index), index);
      }
      if (size === perChunk) {
        tbody.appendChild(chunk.cloneNode(true));
      } else {
        const partial = document.createDocumentFragment();
        for (let local = 0; local < size; local++) {
          partial.appendChild((templateRows[local] as HTMLTableRowElement).cloneNode(true));
        }
        tbody.appendChild(partial);
      }
      done += size;
    }
  };

  // Detach the body during a full rebuild so layout/paint happens once on reattach.
  const rebuild = (count: number, make: (index: number) => T): void => {
    const parent = tbody.parentNode;
    const nextSibling = tbody.nextSibling;
    if (parent) {
      parent.removeChild(tbody);
    }
    tbody.textContent = "";
    selectedRow = undefined;
    build(count, make, 0);
    if (parent) {
      parent.insertBefore(tbody, nextSibling);
    }
  };

  const replace = (items: readonly T[]): void => rebuild(items.length, (index) => items[index] as T);

  const replaceEach = (count: number, make: (index: number) => T): void => {
    positiveInteger("count", count);
    rebuild(count, make);
  };

  const append = (items: readonly T[]): void => {
    const start = tbody.childElementCount;
    build(items.length, (index) => items[index - start] as T, start);
  };

  const appendEach = (count: number, make: (index: number) => T): void => {
    positiveInteger("count", count);
    build(count, make, tbody.childElementCount);
  };

  const update = (stride: number, patch: (row: HTMLTableRowElement, index: number) => void): void => {
    positiveInteger("stride", stride);
    const rows = tbody.children;
    const total = rows.length;
    for (let index = 0; index < total; index += stride) {
      patch(rows[index] as HTMLTableRowElement, index);
    }
  };

  const removeRow = (row: HTMLTableRowElement): void => {
    if (row === selectedRow) {
      selectedRow = undefined;
    }
    row.remove();
  };

  const removeAt = (index: number): void => {
    const row = tbody.children[index];
    if (row) {
      removeRow(row as HTMLTableRowElement);
    }
  };

  const swap = (a: number, b: number): void => {
    if (a === b) {
      return;
    }
    const rows = tbody.children;
    const rowA = rows[a] as HTMLTableRowElement | undefined;
    const rowB = rows[b] as HTMLTableRowElement | undefined;
    if (!rowA || !rowB) {
      return;
    }
    const activeElement = tbody.ownerDocument.activeElement;
    const restoreFocus =
      activeElement &&
      activeElement !== tbody.ownerDocument.body &&
      (rowA.contains(activeElement) || rowB.contains(activeElement)) &&
      "focus" in activeElement
        ? (activeElement as HTMLElement)
        : undefined;
    const nextA = rowA.nextSibling;
    const move = (row: HTMLTableRowElement, before: Node | null): boolean => {
      const movable = tbody as MoveBeforeTableSection;
      if (typeof movable.moveBefore === "function") {
        try {
          movable.moveBefore(row, before);
          return true;
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "HierarchyRequestError")) {
            throw error;
          }
        }
      }
      tbody.insertBefore(row, before);
      return false;
    };
    if (nextA === rowB) {
      if (!move(rowB, rowA)) restoreFocus?.focus({ preventScroll: true });
      return;
    }
    const nextB = rowB.nextSibling;
    if (nextB === rowA) {
      if (!move(rowA, rowB)) restoreFocus?.focus({ preventScroll: true });
      return;
    }
    const nativeA = move(rowB, nextA);
    const nativeB = move(rowA, nextB);
    if (!nativeA || !nativeB) restoreFocus?.focus({ preventScroll: true });
  };

  const clear = (): void => {
    selectedRow = undefined;
    tbody.textContent = "";
  };

  const selectRow = (row: HTMLTableRowElement | null): void => {
    if (selectedRow === row) {
      return;
    }
    if (selectedRow) {
      selectedRow.classList.remove(selectedClass);
    }
    selectedRow = row ?? undefined;
    if (selectedRow) {
      selectedRow.classList.add(selectedClass);
    }
  };

  const selectAt = (index: number): void => {
    const row = tbody.children[index];
    if (row) {
      selectRow(row as HTMLTableRowElement);
    }
  };

  const selectedIndex = (): number =>
    selectedRow && selectedRow.parentNode === tbody ? selectedRow.sectionRowIndex : -1;

  return {
    replace,
    append,
    replaceEach,
    appendEach,
    update,
    removeAt,
    removeRow,
    swap,
    clear,
    selectAt,
    selectRow,
    selectedIndex,
    length: () => tbody.childElementCount,
    rowAt: (index) => tbody.children[index] as HTMLTableRowElement | undefined,
  };
};
