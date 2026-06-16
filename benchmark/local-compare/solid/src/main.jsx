// Adapted from krausest/js-framework-benchmark frameworks/keyed/solid.
import { For, batch, createSelector, createSignal } from "solid-js";
import { render } from "solid-js/web";

const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy",
];
const colors = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"];
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard",
];

const random = (max) => Math.round(Math.random() * 1000) % max;

let nextId = 1;

const buildData = (count) => {
  const data = Array.from({ length: count });
  for (let index = 0; index < count; index++) {
    const [label, setLabel] = createSignal(
      `${adjectives[random(adjectives.length)]} ${colors[random(colors.length)]} ${nouns[random(nouns.length)]}`,
    );
    data[index] = { id: nextId++, label, setLabel };
  }
  return data;
};

const Button = ([id, text, fn]) => (
  <div class="col-sm-6 smallpad">
    <button prop:id={id} class="btn btn-primary btn-block" type="button" onClick={fn}>
      {text}
    </button>
  </div>
);

render(() => {
  const [data, setData] = createSignal([]);
  const [selected, setSelected] = createSignal();
  const run = () => setData(buildData(1_000));
  const runLots = () => setData(buildData(10_000));
  const add = () => setData((rows) => [...rows, ...buildData(1_000)]);
  const update = () =>
    batch(() => {
      const rows = data();
      for (let index = 0; index < rows.length; index += 10) {
        rows[index].setLabel((label) => `${label} !!!`);
      }
    });
  const clear = () => setData([]);
  const swapRows = () => {
    const rows = data().slice();
    if (rows.length > 998) {
      const row = rows[1];
      rows[1] = rows[998];
      rows[998] = row;
      setData(rows);
    }
  };
  const remove = (id) =>
    setData((rows) =>
      rows.toSpliced(
        rows.findIndex((row) => row.id === id),
        1,
      ),
    );
  const isSelected = createSelector(selected);

  return (
    <div class="container">
      <div class="jumbotron">
        <div class="row">
          <div class="col-md-6">
            <h1>Solid</h1>
          </div>
          <div class="col-md-6">
            <div class="row">
              <Button {...["run", "Create 1,000 rows", run]} />
              <Button {...["runlots", "Create 10,000 rows", runLots]} />
              <Button {...["add", "Append 1,000 rows", add]} />
              <Button {...["update", "Update every 10th row", update]} />
              <Button {...["clear", "Clear", clear]} />
              <Button {...["swaprows", "Swap Rows", swapRows]} />
            </div>
          </div>
        </div>
      </div>
      <table class="table table-hover table-striped test-data">
        <tbody id="tbody">
          <For each={data()}>
            {(row) => {
              const rowId = row.id;
              return (
                <tr class={isSelected(rowId) ? "danger" : ""}>
                  <td class="col-md-1" textContent={rowId} />
                  <td class="col-md-4">
                    <a onClick={() => setSelected(rowId)} textContent={row.label()} />
                  </td>
                  <td class="col-md-1">
                    <a onClick={() => remove(rowId)}>
                      <span class="glyphicon glyphicon-remove" aria-hidden="true" />
                    </a>
                  </td>
                  <td class="col-md-6" />
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
      <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true" />
    </div>
  );
}, document.getElementById("main"));
