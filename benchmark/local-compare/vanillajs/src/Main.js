"use strict";

// Vendored from krausest/js-framework-benchmark frameworks/keyed/vanillajs.
function _random(max) {
  return Math.round(Math.random() * 1000) % max;
}

const rowTemplate = document.createElement("tr");
rowTemplate.innerHTML =
  "<td class='col-md-1'> </td><td class='col-md-4'><a> </a></td><td class='col-md-1'><a><span class='glyphicon glyphicon-remove' aria-hidden='true'></span></a></td><td class='col-md-6'></td>";

class Store {
  constructor() {
    this.data = [];
    this.backup = null;
    this.selected = null;
    this.id = 1;
  }

  buildData(count = 1000) {
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
    const data = [];
    for (let i = 0; i < count; i++) {
      data.push({
        id: this.id++,
        label:
          adjectives[_random(adjectives.length)] +
          " " +
          colours[_random(colours.length)] +
          " " +
          nouns[_random(nouns.length)],
      });
    }
    return data;
  }

  updateData() {
    for (let i = 0; i < this.data.length; i += 10) {
      this.data[i].label += " !!!";
    }
  }

  delete(id) {
    const idx = this.data.findIndex((d) => d.id == id);
    this.data = this.data.filter((_, i) => i != idx);
    return this;
  }

  run() {
    this.data = this.buildData();
    this.selected = null;
  }

  add() {
    this.data = this.data.concat(this.buildData(1000));
    this.selected = null;
  }

  update() {
    this.updateData();
    this.selected = null;
  }

  select(id) {
    this.selected = id;
  }

  runLots() {
    this.data = this.buildData(10000);
    this.selected = null;
  }

  clear() {
    this.data = [];
    this.selected = null;
  }

  swapRows() {
    if (this.data.length > 998) {
      const a = this.data[1];
      this.data[1] = this.data[998];
      this.data[998] = a;
    }
  }
}

const getParentId = (elem) => {
  while (elem) {
    if (elem.tagName === "TR") {
      return elem.data_id;
    }
    elem = elem.parentNode;
  }
  return undefined;
};

class Main {
  constructor() {
    this.store = new Store();
    this.select = this.select.bind(this);
    this.delete = this.delete.bind(this);
    this.add = this.add.bind(this);
    this.run = this.run.bind(this);
    this.update = this.update.bind(this);
    this.start = 0;
    this.rows = [];
    this.data = [];
    this.selectedRow = undefined;

    document.getElementById("main").addEventListener("click", (event) => {
      if (event.target.matches("#add")) {
        event.stopPropagation();
        this.add();
      } else if (event.target.matches("#run")) {
        event.stopPropagation();
        this.run();
      } else if (event.target.matches("#update")) {
        event.stopPropagation();
        this.update();
      } else if (event.target.matches("#runlots")) {
        event.stopPropagation();
        this.runLots();
      } else if (event.target.matches("#clear")) {
        event.stopPropagation();
        this.clear();
      } else if (event.target.matches("#swaprows")) {
        event.stopPropagation();
        this.swapRows();
      }
    });
    document.getElementById("tbody").addEventListener("click", (event) => {
      event.stopPropagation();
      let p = event.target;
      while (p && p.tagName !== "TD") {
        p = p.parentNode;
      }
      if (!p) return;
      if (p.parentNode.childNodes[1] == p) {
        const id = getParentId(event.target);
        const idx = this.data.findIndex((row) => row.id === id);
        this.select(idx);
      } else if (p.parentNode.childNodes[2] == p) {
        const id = getParentId(event.target);
        const idx = this.data.findIndex((row) => row.id === id);
        this.delete(idx);
      }
    });
    this.tbody = document.getElementById("tbody");
    this.table = document.getElementsByTagName("table")[0];
  }

  run() {
    this.removeAllRows();
    this.store.clear();
    this.rows = [];
    this.data = [];
    this.store.run();
    this.appendRows();
    this.unselect();
  }

  add() {
    this.store.add();
    this.appendRows();
  }

  update() {
    this.store.update();
    for (let i = 0; i < this.data.length; i += 10) {
      this.rows[i].childNodes[1].childNodes[0].firstChild.nodeValue = this.store.data[i].label;
    }
  }

  unselect() {
    if (this.selectedRow !== undefined) {
      this.selectedRow.className = "";
      this.selectedRow = undefined;
    }
  }

  select(idx) {
    this.unselect();
    this.store.select(this.data[idx].id);
    this.selectedRow = this.rows[idx];
    this.selectedRow.className = "danger";
  }

  recreateSelection() {
    const oldSelection = this.store.selected;
    const selectedIndex = this.store.data.findIndex((data) => data.id === oldSelection);
    if (selectedIndex >= 0) {
      this.store.select(this.data[selectedIndex].id);
      this.selectedRow = this.rows[selectedIndex];
      this.selectedRow.className = "danger";
    }
  }

  delete(idx) {
    this.store.delete(this.data[idx].id);
    this.rows[idx].remove();
    this.rows.splice(idx, 1);
    this.data.splice(idx, 1);
    this.unselect();
    this.recreateSelection();
  }

  removeAllRows() {
    this.tbody.textContent = "";
  }

  runLots() {
    this.removeAllRows();
    this.store.clear();
    this.rows = [];
    this.data = [];
    this.store.runLots();
    this.appendRows();
    this.unselect();
  }

  clear() {
    this.store.clear();
    this.rows = [];
    this.data = [];
    this.removeAllRows();
    this.unselect();
  }

  swapRows() {
    if (this.data.length > 10) {
      this.store.swapRows();
      this.data[1] = this.store.data[1];
      this.data[998] = this.store.data[998];

      this.tbody.insertBefore(this.rows[998], this.rows[2]);
      this.tbody.insertBefore(this.rows[1], this.rows[999]);

      const tmp = this.rows[998];
      this.rows[998] = this.rows[1];
      this.rows[1] = tmp;
    }
  }

  appendRows() {
    const rows = this.rows;
    const sData = this.store.data;
    const data = this.data;
    const tbody = this.tbody;
    const empty = !tbody.firstChild;
    if (empty) {
      tbody.remove();
    }
    for (let i = rows.length; i < sData.length; i++) {
      const tr = this.createRow(sData[i]);
      rows[i] = tr;
      data[i] = sData[i];
      tbody.appendChild(tr);
    }
    if (empty) {
      this.table.insertBefore(tbody, null);
    }
  }

  createRow(data) {
    const tr = rowTemplate.cloneNode(true);
    const td1 = tr.firstChild;
    const a2 = td1.nextSibling.firstChild;
    tr.data_id = data.id;
    td1.firstChild.nodeValue = data.id;
    a2.firstChild.nodeValue = data.label;
    return tr;
  }
}

new Main();
