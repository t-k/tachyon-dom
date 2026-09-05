import { describe, expect, it } from "vitest";
import { createTemplateComponent } from "../src/runtime/component";
import { effect } from "../src/runtime/signal";

describe("reusable template component interface", () => {
  it("keeps instances independent and applies reactive prop updates", () => {
    const component = createTemplateComponent({
      client: {
        templateHtml: "<p></p>",
        bind: (root, scope) => {
          const paragraph = root as HTMLParagraphElement;
          return effect(() => {
            paragraph.textContent = String(scope.label);
          });
        },
      },
      render: (props: { label: string }) => `<p>${props.label}</p>`,
    });
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);

    const first = component.mount(firstRoot, { label: "first" });
    const second = component.mount(secondRoot, { label: "second" });

    first.update({ label: "updated" });

    expect(firstRoot.innerHTML).toBe("<p>updated</p>");
    expect(secondRoot.innerHTML).toBe("<p>second</p>");
    expect(component.render({ label: "server" })).toBe("<p>server</p>");

    first.dispose();
    second.dispose();
    expect(first.disposed()).toBe(true);
    expect(second.disposed()).toBe(true);
  });

  it("hydrates the same client component contract without replacing SSR markup", () => {
    const component = createTemplateComponent({
      client: {
        templateHtml: "<button>SSR</button>",
        bind: (root, scope) => {
          (root as HTMLButtonElement).textContent = String(scope.label);
        },
      },
      render: (props: { label: string }) => `<button>${props.label}</button>`,
    });
    const root = document.createElement("div");
    root.innerHTML = component.render({ label: "SSR" });
    const before = root.innerHTML;

    const result = component.hydrate(root, { label: "SSR" });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.ok).toBe(true);
    expect(root.innerHTML).toBe(before);
    if (result.ok) result.value.dispose();
  });

  it("passes slot data through the typed scope factory", () => {
    const component = createTemplateComponent({
      client: {
        templateHtml: "<div></div>",
        bind: (root, scope) => {
          (root as HTMLDivElement).textContent = String(scope.slots?.default ?? "");
        },
      },
      scope: (props: { label: string; slots: { default: string } }) => props,
      render: (props: { label: string; slots: { default: string } }) => `<div>${props.slots.default}</div>`,
    });
    const root = document.createElement("div");

    component.mount(root, { label: "ignored", slots: { default: "child" } });

    expect(root.textContent).toBe("child");
  });
});
