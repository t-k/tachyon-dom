import { describe, expect, it } from "vitest";
import { setAttributeValue, setRef, setStyleValue } from "../src/runtime/attr";
import { bindControl, setControlValue } from "../src/runtime/form";

describe("attribute and form runtime helpers", () => {
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
});
