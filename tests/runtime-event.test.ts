import { describe, expect, it, vi } from "vitest";
import { delegate } from "../src/runtime/event";

describe("runtime event delegation", () => {
  it("attaches delegated listeners to the root and filters by path", () => {
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

    const cleanup = delegate(root, "click", [0], handler);

    expect(rootAdd).toHaveBeenCalledTimes(1);
    expect(buttonAdd).not.toHaveBeenCalled();

    root.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    root.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(currentTargets).toEqual([button]);

    cleanup();
    expect(rootRemove).toHaveBeenCalledTimes(1);
  });
});
