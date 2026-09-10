import { describe, expect, it } from "vitest";
import { createErrorBoundary } from "../src/runtime/error-boundary";
import { rawHtml } from "../src/runtime/router";
import { createSignal, effect, untrack } from "../src/runtime/signal";

describe("runtime error boundary", () => {
  it("routes a later untracked child effect failure to its nearest boundary", () => {
    const root = document.createElement("section");
    const value = createSignal("ok");
    const errors: string[] = [];
    const dispose = createErrorBoundary(root, {
      render: (target) => {
        untrack(() =>
          effect(() => {
            const current = value();
            if (current === "bad") throw new Error("child");
            target.textContent = current;
          }),
        );
      },
      fallback: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
        return "fallback";
      },
    });

    expect(() => value.set("bad")).not.toThrow();
    expect(errors).toEqual(["child"]);
    expect(root.textContent).toBe("fallback");
    value.set("recovered");
    expect(root.textContent).toBe("recovered");
    dispose();
    expect(() => value.set("bad")).not.toThrow();
    expect(errors).toEqual(["child"]);
  });

  it("routes a throwing child fallback to its parent boundary", () => {
    const root = document.createElement("main");
    const childRoot = document.createElement("section");
    root.appendChild(childRoot);
    const value = createSignal("ok");
    let disposeChild: (() => void) | undefined;
    const disposeParent = createErrorBoundary(root, {
      render: () => {
        disposeChild = createErrorBoundary(childRoot, {
          render: () => {
            effect(() => {
              if (value() === "bad") throw new Error("child render");
            });
          },
          fallback: () => {
            throw new Error("child fallback");
          },
        });
      },
      fallback: (error) => `parent: ${error instanceof Error ? error.message : String(error)}`,
    });

    expect(() => value.set("bad")).not.toThrow();
    expect(root.textContent).toBe("parent: child fallback");
    disposeChild?.();
    disposeParent();
  });

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

  it.each([
    ["Node", () => Object.assign(document.createElement("p"), { textContent: "node" }), "node"],
    [
      "DocumentFragment",
      () => {
        const fragment = document.createDocumentFragment();
        fragment.append("fragment");
        return fragment;
      },
      "fragment",
    ],
    ["Node array", () => [document.createTextNode("first"), document.createTextNode("second")], "firstsecond"],
  ])("renders an explicit %s fallback", (_name, fallback, expected) => {
    const root = document.createElement("section");
    const dispose = createErrorBoundary(root, {
      render: () => {
        throw new Error("broken");
      },
      fallback,
    });

    expect(root.textContent).toBe(expected);
    dispose();
  });
});
