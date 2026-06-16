"use strict";

// Vendored from krausest/js-framework-benchmark frameworks/keyed/vanillajs-3.
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

const tbody = document.querySelector("tbody");
const l1 = adjectives.length;
const l2 = colours.length;
const l3 = nouns.length;
let index = 1;
let op = null;
let c1 = null;
let c2 = null;
let c998 = null;
let data = [];
let selected = null;

const app = {
  run(n = 1000) {
    if (data.length) app.clear();
    app.add(n);
  },
  runlots() {
    app.run(10000);
  },
  add(n = 1000) {
    const item = document.querySelector("template").content.firstElementChild;
    const id = item.firstElementChild.firstChild;
    const lbl = item.querySelector("a").firstChild;
    for (let i = 0; i < n; i++) {
      id.nodeValue = index++;
      data.push(
        (lbl.nodeValue = `${adjectives[Math.round(Math.random() * 1000) % l1]} ${
          colours[Math.round(Math.random() * 1000) % l2]
        } ${nouns[Math.round(Math.random() * 1000) % l3]}`),
      );
      tbody.appendChild(item.cloneNode(true));
    }
  },
  update() {
    for (let i = 0, item; i < data.length; i += 10) {
      if (op === "update" && item?.hasOwnProperty("next")) item = item.next;
      else if (item) {
        item.next = tbody.childNodes[i];
        item = item.next;
      } else item = tbody.childNodes[i];
      if (!item.hasOwnProperty("el")) item.el = item.querySelector("a").firstChild;
      item.el.nodeValue = data[i] += " !!!";
    }
  },
  clear() {
    tbody.textContent = "";
    data = [];
  },
  swaprows() {
    if (data.length < 999) return;
    const d1 = data[1];
    data[1] = data[998];
    data[998] = d1;
    if (op === "swaprows") {
      const temp = c1;
      c1 = c998;
      c998 = temp;
    } else {
      c1 = tbody.children[1];
      c2 = c1.nextElementSibling;
      c998 = tbody.children[998];
    }
    tbody.insertBefore(c1, c998);
    tbody.insertBefore(c998, c2);
  },
};

tbody.onclick = (event) => {
  event.stopPropagation();
  event.preventDefault();
  op = "null";
  if (event.target.tagName === "A") {
    const element = event.target.parentNode.parentNode;
    if (selected) selected.className = "";
    selected = element === selected ? null : element;
    if (selected) selected.className = "danger";
  } else if (event.target.tagName === "SPAN") {
    const element = event.target.parentNode.parentNode.parentNode;
    const selectedIndex = Array.prototype.indexOf.call(tbody.children, element);
    element.remove();
    data.splice(selectedIndex, 1);
  }
};

document.querySelector("#app-actions").onclick = (event) => {
  event.stopPropagation();
  event.preventDefault();
  app[event.target.id]();
  op = event.target.id;
};
