import { createKeyedRows } from "../src/runtime/keyed-rows.js";
import type { GeneratedTemplateDriver, GeneratedTemplateItem } from "./generated-template-driver.js";

const rowHtml = `<tr class="row"><td> </td><td><input value=""><span> </span></td><td> </td><td><ul></ul></td></tr>`;

type ListDriver = GeneratedTemplateDriver;

export const createKeyedRowsDriver = (tbody: HTMLTableSectionElement): ListDriver => {
  const cellText = (row: HTMLTableRowElement, index: number): Text => {
    const text = row.cells[index]?.firstChild;
    if (!(text instanceof Text)) throw new Error(`Missing benchmark cell ${index}.`);
    return text;
  };
  const listenerCleanups = new Map<HTMLTableRowElement, () => void>();
  const itemsByRow = new WeakMap<HTMLTableRowElement, GeneratedTemplateItem>();
  // Child identity is tracked off-DOM so the markup stays identical to the
  // generated paths.
  const childKeys = new WeakMap<Element, number>();
  let current: readonly GeneratedTemplateItem[] = [];
  const syncChildren = (row: HTMLTableRowElement, item: GeneratedTemplateItem): void => {
    const list = row.cells[3]?.querySelector("ul");
    if (!list) throw new Error("Missing benchmark child list.");
    const existing = new Map<number, Element>();
    for (const child of Array.from(list.children)) {
      const key = childKeys.get(child);
      if (child.tagName === "LI" && key !== undefined) existing.set(key, child);
    }
    const next: Element[] = [];
    for (const tag of item.tags) {
      let child = existing.get(tag.id);
      if (!child) {
        child = row.ownerDocument.createElement("li");
        childKeys.set(child, tag.id);
      }
      child.textContent = tag.name;
      next.push(child);
    }
    list.replaceChildren(...next);
  };
  const bindRow = (row: HTMLTableRowElement, item: GeneratedTemplateItem): void => {
    itemsByRow.set(row, item);
    cellText(row, 0).data = String(item.id);
    const input = row.cells[1]?.querySelector("input");
    const label = row.cells[1]?.querySelector("span");
    if (!(input instanceof HTMLInputElement) || !(label instanceof HTMLSpanElement)) {
      throw new Error("Missing benchmark label controls.");
    }
    input.value = item.label;
    label.textContent = item.label;
    cellText(row, 2).data = item.selected ? "selected" : "";
    row.classList.toggle("selected", item.selected);
    syncChildren(row, item);
    if (!listenerCleanups.has(row)) {
      // Mirrors the template's bind:value contract: the model property is
      // written; a text binding on a plain item object does not re-render.
      const onInput = (): void => {
        const bound = itemsByRow.get(row);
        if (bound) bound.label = input.value;
      };
      const onClick = (): void => itemsByRow.get(row)?.onClick();
      input.addEventListener("input", onInput);
      row.addEventListener("click", onClick);
      listenerCleanups.set(row, () => {
        input.removeEventListener("input", onInput);
        row.removeEventListener("click", onClick);
      });
    }
  };
  const driver = createKeyedRows<GeneratedTemplateItem>({ tbody, row: rowHtml, bind: bindRow });
  const rowElements = (): HTMLTableRowElement[] =>
    Array.from(tbody.children).filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement);
  const rebindAll = (items: readonly GeneratedTemplateItem[]): void => {
    const rows = rowElements();
    items.forEach((item, index) => {
      const row = rows[index];
      if (row) bindRow(row, item);
    });
  };
  const replace = (items: readonly GeneratedTemplateItem[]): void => {
    current = [...items];
    driver.replace(current);
    rebindAll(current);
  };
  const inputAt = (rowIndex: number): HTMLInputElement => {
    const input = rowElements()[rowIndex]?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for row ${rowIndex}.`);
    return input;
  };
  return {
    replace,
    append: (items) => {
      current = [...current, ...items];
      driver.append(items);
      rebindAll(current);
    },
    partialUpdate: (items) => {
      current = items.map((item, index) => (index % 5 === 0 ? { ...item, label: `${item.label} !` } : item));
      rebindAll(current);
    },
    swap: () => {
      const last = driver.length() - 2;
      if (last < 2) return;
      const next = [...current];
      [next[1], next[last]] = [next[last] as GeneratedTemplateItem, next[1] as GeneratedTemplateItem];
      current = next;
      driver.swap(1, last);
      rebindAll(current);
    },
    remove: () => {
      current = current.filter((_, index) => index !== 2);
      driver.removeAt(2);
      rebindAll(current);
    },
    reorderChildren: () => {
      current = current.map((item, index) => (index % 3 === 0 ? { ...item, tags: [...item.tags].reverse() } : item));
      rebindAll(current);
    },
    emptyChildren: () => {
      current = current.map((item, index) => (index % 4 === 1 ? { ...item, tags: [] } : item));
      rebindAll(current);
    },
    dispose: () => {
      for (const cleanup of listenerCleanups.values()) cleanup();
      listenerCleanups.clear();
      current = [];
      driver.clear();
    },
    rows: rowElements,
    childRows: (rowIndex) => Array.from(rowElements()[rowIndex]?.querySelectorAll("li") ?? []),
    typeInto: (rowIndex, value) => {
      const input = inputAt(rowIndex);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    click: (rowIndex) => {
      const row = rowElements()[rowIndex];
      if (!row) throw new Error(`Missing row ${rowIndex}.`);
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    setSelected: (rowIndex, selected) => {
      current = current.map((item, index) => (index === rowIndex ? { ...item, selected } : item));
      rebindAll(current);
    },
    inputValue: (rowIndex) => inputAt(rowIndex).value,
    current: () => current,
  };
};
