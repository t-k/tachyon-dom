import { describe, expect, it } from "vitest";
import { createErrorBoundary } from "../src/runtime/error-boundary";
import { createSignal } from "../src/runtime/signal";

describe("runtime error boundary", () => {
  it("renders fallback for a throwing island without replacing siblings", () => {
    document.body.innerHTML = `<main><section id="island"></section><aside id="sibling">stable</aside></main>`;
    const island = document.querySelector("#island");
    const sibling = document.querySelector("#sibling");
    if (!(island instanceof HTMLElement) || !(sibling instanceof HTMLElement)) {
      throw new Error("Missing test nodes.");
    }
    const value = createSignal("ok");
    const dispose = createErrorBoundary(island, {
      render: (root) => {
        if (value() === "bad") {
          throw new Error("broken");
        }
        root.textContent = value();
      },
      fallback: (error) => `<p role="alert">${error instanceof Error ? error.message : "error"}</p>`,
    });

    expect(island.textContent).toBe("ok");
    value.set("bad");

    expect(island.innerHTML).toBe(`<p role="alert">broken</p>`);
    expect(document.querySelector("#sibling")).toBe(sibling);
    dispose();
  });
});
