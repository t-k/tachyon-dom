// Vendored from krausest/js-framework-benchmark frameworks/keyed/vanillajs-lite.
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
const colours = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"];
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

const pick = (dict) => dict[Math.round(Math.random() * 1000) % dict.length];
const label = () => `${pick(adjectives)} ${pick(colours)} ${pick(nouns)}`;
const labelOf = (row) => row.firstChild.nextSibling.firstChild.firstChild;

let ID = 1;
let SEL;
let TMPL;
let SIZE;
const [[TABLE], [TBODY], [TROW], BUTTONS] = "table,tbody,#trow,button"
  .split(",")
  .map((selector) => document.querySelectorAll(selector));
const ROWS = TBODY.children;

const { cloneNode, insertBefore } = Node.prototype;
const clone = (node) => cloneNode.call(node, true);
const insert = insertBefore.bind(TBODY);
const clear = () => {
  TBODY.textContent = "";
  SEL = null;
};
const create = (count, add) => {
  if (SIZE !== count) {
    TMPL = clone(TROW.content);
    [...Array((SIZE = count) / 50 - 1)].forEach(() => TMPL.appendChild(clone(TMPL.firstChild)));
  }
  if (!add) {
    clear();
    TBODY.remove();
  }
  while (count) {
    for (const row of TMPL.children) {
      (row.$id ??= row.firstChild.firstChild).nodeValue = ID++;
      (row.$label ??= labelOf(row)).nodeValue = label();
      count--;
    }
    insert(clone(TMPL), null);
  }
  if (!add) {
    TABLE.appendChild(TBODY);
  }
};

BUTTONS.forEach(
  function attach(button) {
    button.onclick = this[button.id];
  },
  {
    run() {
      create(1000);
    },
    runlots() {
      create(10000);
    },
    add() {
      create(1000, true);
    },
    clear,
    update() {
      for (let index = 0, row; (row = ROWS[index]); index += 10) {
        labelOf(row).nodeValue += " !!!";
      }
    },
    swaprows() {
      const [, row1, row2] = ROWS;
      const row998 = ROWS[998];
      if (row998) {
        insert(row1, row998);
        insert(row998, row2);
      }
    },
  },
);

TBODY.onclick = (event) => {
  const target = event.target;
  const tagName = target.tagName;
  const row = target.closest("TR");
  event.stopPropagation();
  if (tagName === "SPAN" || (tagName === "A" && target.firstElementChild)) {
    row.remove();
  } else if (tagName === "A") {
    if (SEL) {
      SEL.className = "";
    }
    SEL = row;
    SEL.className = "danger";
  }
};
