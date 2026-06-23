import { createKeyedRows } from "../../../src/runtime/keyed-rows";

const adjectives =
  "pretty large big small tall short long handsome plain quaint clean elegant easy angry crazy helpful mushy odd unsightly adorable important inexpensive cheap expensive fancy".split(
    " ",
  );
const colours = "red yellow blue green pink brown purple brown white black orange".split(" ");
const nouns = "table chair house bbq desk car pony cookie sandwich burger pizza mouse keyboard".split(" ");

const pick = (words: readonly string[]) => words[(Math.random() * words.length) | 0] as string;
const label = () => `${pick(adjectives)} ${pick(colours)} ${pick(nouns)}`;
const labelText = (row: HTMLTableRowElement) => row.children[1]!.firstChild!.firstChild as Text;

let nextId = 1;

export const mount = (root: ParentNode = document) => {
  const tbody = root.querySelector("#tbody") as HTMLTableSectionElement;
  const list = createKeyedRows<string>({
    tbody,
    row: '<tr><td class="col-md-1"> </td><td class="col-md-4"><a> </a></td><td class="col-md-1"><a><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td><td class="col-md-6"></td></tr>',
    bind: (row, text) => {
      (row.firstChild!.firstChild as Text).data = String(nextId++);
      labelText(row).data = text;
    },
    selectedClass: "danger",
  });

  const click = (id: string, run: () => void) => {
    (root.querySelector(`#${id}`) as HTMLElement).onclick = run;
  };
  click("run", () => list.replaceEach(1000, label));
  click("runlots", () => list.replaceEach(10000, label));
  click("add", () => list.appendEach(1000, label));
  click("update", () => list.update(10, (row) => (labelText(row).data += " !!!")));
  click("clear", list.clear);
  click("swaprows", () => list.swap(1, 998));

  tbody.addEventListener("click", (event) => {
    const action = (event.target as Element).closest("a");
    const row = action?.closest("tr") as HTMLTableRowElement | null;
    if (action && row) {
      if (action.firstElementChild) {
        list.removeRow(row);
      } else {
        list.selectRow(row);
      }
    }
  });

  return list;
};

if (typeof document !== "undefined" && document.getElementById("run")) {
  mount();
}
