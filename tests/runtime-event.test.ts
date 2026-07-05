import { describe, expect, it, vi } from "vitest";
import { delegate } from "../src/runtime/event";

describe("runtime event delegation", () => {
  it("attaches listeners to the target path so non-bubbling events fire", () => {
    document.body.innerHTML = `<section><button><span>Save</span></button><a href="#">Other</a></section>`;
    const root = document.querySelector("section");
    const button = document.querySelector("button");
    if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("Missing event test nodes.");
    }
    const rootAdd = vi.spyOn(root, "addEventListener");
    const rootRemove = vi.spyOn(root, "removeEventListener");
    const buttonAdd = vi.spyOn(button, "addEventListener");
    const currentTargets: Array<EventTarget | null> = [];
    const handler = vi.fn((event: Event) => {
      currentTargets.push(event.currentTarget);
    });

    const cleanup = delegate(root, "focus", [0], handler);

    expect(rootAdd).not.toHaveBeenCalled();
    expect(buttonAdd).toHaveBeenCalledTimes(1);

    root.querySelector("a")?.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    button.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(currentTargets).toEqual([button]);

    cleanup();
    expect(rootRemove).not.toHaveBeenCalled();
  });

  it("preserves DOM listener order and stopPropagation for nested handlers", () => {
    document.body.innerHTML = `<section><button><span>Save</span></button></section>`;
    const root = document.querySelector("section");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing event test root.");
    }
    const calls: string[] = [];

    const cleanupParent = delegate(root, "click", [0], () => calls.push("parent"));
    const cleanupChild = delegate(root, "click", [0, 0], (event) => {
      calls.push("child");
      event.stopPropagation();
    });

    root.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(calls).toEqual(["child"]);
    cleanupChild();
    cleanupParent();
  });
});
