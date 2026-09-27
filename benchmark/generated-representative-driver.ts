import type {
  GeneratedClientModule,
  GeneratedTemplateDriver,
  GeneratedTemplateItem,
} from "./generated-template-driver.js";

export const createGeneratedTemplateDriver = (
  tbody: HTMLTableSectionElement,
  module: GeneratedClientModule,
): GeneratedTemplateDriver => {
  const table = tbody.closest("table");
  if (!(table instanceof HTMLTableElement)) throw new Error("Generated benchmark table is missing.");
  const rows = module.createSignal<readonly GeneratedTemplateItem[]>([]);
  const scope: Record<string, unknown> = { rows, noop: () => undefined };
  let cleanup: (() => void) | undefined;
  let active = false;
  let current: readonly GeneratedTemplateItem[] = [];
  const ensureBound = (): void => {
    if (active) return;
    cleanup = module.bind(table, scope) ?? undefined;
    active = true;
  };
  const replace = (items: readonly GeneratedTemplateItem[]): void => {
    ensureBound();
    current = [...items];
    rows.set(current);
  };
  const rowElements = (): HTMLTableRowElement[] =>
    Array.from(tbody.children).filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement);
  const inputAt = (rowIndex: number): HTMLInputElement => {
    const input = rowElements()[rowIndex]?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for row ${rowIndex}.`);
    return input;
  };
  return {
    replace,
    append: (items) => replace([...current, ...items]),
    partialUpdate: (items) =>
      replace(items.map((item, index) => (index % 5 === 0 ? { ...item, label: `${item.label} !` } : item))),
    noChange: () => replace([...current]),
    sparseUpdate: (percent, mutable) => {
      const stride = 100 / percent;
      if (mutable) {
        for (let index = 0; index < current.length; index += stride) {
          const item = current[index];
          if (item) item.label += " *";
        }
        replace([...current]);
      } else {
        replace(current.map((item, index) => (index % stride === 0 ? { ...item, label: `${item.label} *` } : item)));
      }
    },
    swap: () => {
      const next = [...current];
      const last = next.length - 2;
      if (last < 2) return;
      [next[1], next[last]] = [next[last] as GeneratedTemplateItem, next[1] as GeneratedTemplateItem];
      replace(next);
    },
    remove: () => replace(current.filter((_, index) => index !== 2)),
    reorderChildren: () =>
      replace(current.map((item, index) => (index % 3 === 0 ? { ...item, tags: [...item.tags].reverse() } : item))),
    emptyChildren: () => replace(current.map((item, index) => (index % 4 === 1 ? { ...item, tags: [] } : item))),
    dispose: () => {
      if (!active) return;
      cleanup?.();
      cleanup = undefined;
      active = false;
      current = [];
      rows.set([]);
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
    setSelected: (rowIndex, selected) =>
      replace(current.map((item, index) => (index === rowIndex ? { ...item, selected } : item))),
    inputValue: (rowIndex) => inputAt(rowIndex).value,
    current: () => current,
  };
};
