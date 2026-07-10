import { describe, expect, it } from "vitest";
import { createErrorBoundary } from "../src/runtime/error-boundary";
import { rawHtml } from "../src/runtime/router";
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
      fallback: (error) => rawHtml(`<p role="alert">${error instanceof Error ? error.message : "error"}</p>`),
    });

    expect(island.textContent).toBe("ok");
    value.set("bad");

    expect(island.innerHTML).toBe(`<p role="alert">broken</p>`);
    expect(document.querySelector("#sibling")).toBe(sibling);
    dispose();
  });

  it("renders ordinary fallback strings as text and accepts explicit client HTML", () => {
    const plainRoot = document.createElement("section");
    const trustedRoot = document.createElement("section");
    const value = createSignal("ok");
    const plainDispose = createErrorBoundary(plainRoot, {
      render: () => {
        if (value() === "bad") {
          throw new Error('<img src=x onerror="window.__xss = true">');
        }
      },
      fallback: (error) => (error instanceof Error ? `<p>${error.message}</p>` : "error"),
    });
    const trustedDispose = createErrorBoundary(trustedRoot, {
      render: () => {
        throw new Error("trusted");
      },
      fallback: () => rawHtml('<p role="alert">trusted</p>'),
    });

    value.set("bad");

    expect(plainRoot.querySelector("img")).toBeNull();
    expect(plainRoot.textContent).toBe('<p><img src=x onerror="window.__xss = true"></p>');
    expect(trustedRoot.innerHTML).toBe('<p role="alert">trusted</p>');
    plainDispose();
    trustedDispose();
  });
});
