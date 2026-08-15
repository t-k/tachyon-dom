import { describe, expect, it } from "vitest";
import { setAttributeValue, setRef, setStyleValue } from "../src/runtime/attr";
import { setClassPresence } from "../src/runtime/class";
import { bindControl, setControlValue } from "../src/runtime/form";

describe("attribute and form runtime helpers", () => {
  it("retains directive classes when a dynamic base class changes", () => {
    document.body.innerHTML = `<div></div>`;
    const element = document.body.firstElementChild;
    if (!(element instanceof HTMLDivElement)) throw new Error("Missing element.");

    setAttributeValue(element, "class", "one");
    setClassPresence(element, "active", true);
    setAttributeValue(element, "class", "two");
    expect(element.className).toBe("two active");

    setClassPresence(element, "active", false);
    expect(element.className).toBe("two");
    setAttributeValue(element, "class", null);
    expect(element.hasAttribute("class")).toBe(false);
  });

  it("does not remove a base class token when the matching directive is false", () => {
    document.body.innerHTML = `<div></div>`;
    const element = document.body.firstElementChild;
    if (!(element instanceof HTMLDivElement)) throw new Error("Missing element.");

    setAttributeValue(element, "class", "card active");
    setClassPresence(element, "active", false);
    expect(element.className).toBe("card active");

    setClassPresence(element, "active", true);
    expect(element.className).toBe("card active");
    setClassPresence(element, "active", false);
    setAttributeValue(element, "class", "active selected");
    expect(element.className).toBe("active selected");
  });

  it("sets DOM attributes, reflected properties, styles, and refs", () => {
    document.body.innerHTML = `<button></button>`;
    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Missing button.");
    }
    const scope: { refs: { button?: Element } } = { refs: {} };

    setAttributeValue(button, "disabled", true);
    setAttributeValue(button, "aria-label", "Save");
    setStyleValue(button, "width", "10px");
    setRef(scope, "refs.button", button);

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Save");
    expect(button.style.width).toBe("10px");
    expect(scope.refs.button).toBe(button);

    setAttributeValue(button, "disabled", false);
    setStyleValue(button, "width", null);

    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.style.width).toBe("");
  });

  it("removes string reflected attributes without writing false into the DOM property", () => {
    document.body.innerHTML = `<button title="Save"></button><input value="Ada">`;
    const button = document.querySelector("button");
    const input = document.querySelector("input");
    if (!(button instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) {
      throw new Error("Missing controls.");
    }

    setAttributeValue(button, "title", null);
    setAttributeValue(input, "value", null);

    expect(button.hasAttribute("title")).toBe(false);
    expect(button.title).toBe("");
    expect(input.hasAttribute("value")).toBe(false);
    expect(input.value).toBe("");
  });

  it.each(["onclick", "ONLOAD", "srcdoc", "innerhtml", "outerhtml"])(
    "rejects dangerous attribute %s before mutating the DOM",
    (name) => {
      document.body.innerHTML = `<div></div>`;
      const element = document.body.firstElementChild;
      if (!(element instanceof HTMLDivElement)) {
        throw new Error("Missing element.");
      }

      for (const value of ["unsafe", null, false, true]) {
        expect(() => setAttributeValue(element, name, value)).toThrow(`Dangerous attribute is not supported: ${name}`);
      }
      expect(element.getAttributeNames()).toEqual([]);
      expect(element.childElementCount).toBe(0);
    },
  );

  it("rejects dangerous attribute names instead of reflecting executable DOM properties", () => {
    document.body.innerHTML = `<div></div><iframe></iframe><button></button>`;
    const div = document.querySelector("div");
    const iframe = document.querySelector("iframe");
    const button = document.querySelector("button");
    if (
      !(div instanceof HTMLDivElement) ||
      !(iframe instanceof HTMLIFrameElement) ||
      !(button instanceof HTMLButtonElement)
    ) {
      throw new Error("Missing elements.");
    }

    expect(() => setAttributeValue(div, "innerHTML", `<img src=x onerror="alert(1)">`)).toThrow(
      "Dangerous attribute is not supported",
    );
    expect(() => setAttributeValue(iframe, "srcdoc", `<script>alert(1)</script>`)).toThrow(
      "Dangerous attribute is not supported",
    );
    expect(() => setAttributeValue(button, "onclick", "alert(1)")).toThrow("Dangerous attribute is not supported");

    expect(div.childElementCount).toBe(0);
    expect(div.hasAttribute("innerHTML")).toBe(false);
    expect(iframe.hasAttribute("srcdoc")).toBe(false);
    expect(iframe.srcdoc).toBe("");
    expect(button.hasAttribute("onclick")).toBe(false);
    expect(button.onclick).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
  ])("rejects active URL %j before mutating a client attribute", (value) => {
    document.body.innerHTML = `<a></a><img><form></form><button></button><svg><use></use></svg>`;
    const cases = [
      [document.querySelector("a"), "href"],
      [document.querySelector("img"), "src"],
      [document.querySelector("form"), "action"],
      [document.querySelector("button"), "formaction"],
      [document.querySelector("use"), "xlink:href"],
    ] as const;
    for (const [element, attribute] of cases) {
      if (!element) throw new Error(`Missing ${attribute} element.`);
      expect(() => setAttributeValue(element, attribute, value)).toThrow(`Unsafe URL for ${attribute}`);
      expect(element.hasAttribute(attribute)).toBe(false);
    }
  });

  it("binds text inputs and checkbox controls", () => {
    document.body.innerHTML = `<input id="name"><input id="active" type="checkbox">`;
    const name = document.querySelector("#name");
    const active = document.querySelector("#active");
    if (!(name instanceof HTMLInputElement) || !(active instanceof HTMLInputElement)) {
      throw new Error("Missing controls.");
    }
    const scope = { name: "Ada", active: true };

    const cleanupName = bindControl(
      name,
      "value",
      () => scope.name,
      (value) => {
        scope.name = String(value);
      },
    );
    const cleanupActive = bindControl(
      active,
      "checked",
      () => scope.active,
      (value) => {
        scope.active = Boolean(value);
      },
    );

    expect(name.value).toBe("Ada");
    expect(active.checked).toBe(true);

    name.value = "Grace";
    name.dispatchEvent(new InputEvent("input", { bubbles: true }));
    active.checked = false;
    active.dispatchEvent(new Event("change", { bubbles: true }));

    expect(scope).toEqual({ name: "Grace", active: false });

    setControlValue(name, "value", "Lin");
    expect(name.value).toBe("Lin");

    cleanupName();
    cleanupActive();
  });

  it("defers text input writes while IME composition is active", () => {
    document.body.innerHTML = `<input id="name">`;
    const name = document.querySelector("#name");
    if (!(name instanceof HTMLInputElement)) {
      throw new Error("Missing input.");
    }
    const scope = { name: "Ada" };

    const cleanup = bindControl(
      name,
      "value",
      () => scope.name,
      (value) => {
        scope.name = String(value);
      },
    );

    name.value = "あ";
    name.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    expect(scope.name).toBe("Ada");

    name.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(scope.name).toBe("あ");

    cleanup();
  });
});
