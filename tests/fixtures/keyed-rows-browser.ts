import { createKeyedRows } from "../../src/index";

declare global {
  interface Window {
    runKeyedSwap: (fallback: boolean) => {
      active: boolean;
      selection: [number | null, number | null];
      value: string;
      blur: number;
      focus: number;
      scrollTop: number;
      inputVisible: boolean;
      ids: string[];
    };
  }
}

window.runKeyedSwap = (fallback) => {
  const tbody = document.querySelector<HTMLTableSectionElement>("#tbody")!;
  tbody.replaceChildren();
  if (fallback) Object.defineProperty(tbody, "moveBefore", { configurable: true, value: undefined });
  const list = createKeyedRows({
    tbody,
    row: "<tr style='height:40px'><td></td><td><input></td></tr>",
    bind: (row, item: { id: number }, index) => {
      row.cells[0]!.textContent = String(item.id);
      const input = row.querySelector("input")!;
      input.value = `value-${index}`;
    },
  });
  list.replaceEach(6, (index) => ({ id: index + 1 }));
  const input = tbody.rows[2]!.querySelector("input")!;
  input.focus();
  input.setSelectionRange(2, 5);
  let blur = 0;
  let focus = 0;
  input.addEventListener("blur", () => blur++);
  input.addEventListener("focus", () => focus++);
  const scroller = document.querySelector<HTMLElement>("#scroller")!;
  scroller.scrollTop = 80;

  list.swap(2, 1);

  const inputRect = input.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();

  return {
    active: document.activeElement === input,
    selection: [input.selectionStart, input.selectionEnd],
    value: input.value,
    blur,
    focus,
    scrollTop: scroller.scrollTop,
    inputVisible: inputRect.top >= scrollerRect.top && inputRect.bottom <= scrollerRect.bottom,
    ids: Array.from(tbody.rows, (row) => row.cells[0]!.textContent ?? ""),
  };
};
