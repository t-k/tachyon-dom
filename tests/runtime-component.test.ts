import { describe, expect, it } from "vitest";
import { createTemplateComponent } from "../src/runtime/component";
import { createSignal, effect, onCleanup } from "../src/runtime/signal";

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

  it("owns effects and cleanup registrations created by the scope factory", () => {
    const signal = createSignal(0);
    let reads = 0;
    let cleanupCalls = 0;
    const component = createTemplateComponent({
      client: {
        templateHtml: "<p></p>",
        bind: () => undefined,
      },
      scope: () => {
        effect(() => {
          signal();
          reads++;
        });
        onCleanup(() => {
          cleanupCalls++;
        });
        return {};
      },
    });
    const instance = component.mount(document.createElement("div"), {});
    const readsBeforeDispose = reads;

    instance.dispose();
    signal.set(1);

    expect(reads).toBe(readsBeforeDispose);
    expect(cleanupCalls).toBe(1);
  });

  it("batches component prop updates so observers do not see an intermediate scope", () => {
    const observed: Array<[number, number]> = [];
    const component = createTemplateComponent({
      client: {
        templateHtml: "<p></p>",
        bind: (_root, scope) =>
          effect(() => {
            observed.push([Number(scope.first), Number(scope.second)]);
          }),
      },
    });
    const instance = component.mount(document.createElement("div"), { first: 1, second: 1 });

    instance.update({ first: 2, second: 2 });

    expect(observed).toEqual([
      [1, 1],
      [2, 2],
    ]);
    instance.dispose();
  });

  it("disposes nested component instances through the parent owner exactly once", () => {
    const childCleanups: string[] = [];
    const child = createTemplateComponent({
      client: {
        templateHtml: "<span></span>",
        bind: (_root, scope) => {
          (_root as HTMLSpanElement).textContent = String(scope.label);
          return () => childCleanups.push(String(scope.label));
        },
      },
    });
    const parent = createTemplateComponent({
      client: {
        templateHtml: "<section><div id=\"child\"></div></section>",
        bind: (root) => {
          const childRoot = root.querySelector("#child");
          if (!childRoot) throw new Error("Missing child root.");
          const instance = child.mount(childRoot, { label: "nested" });
          return () => instance.dispose();
        },
      },
    });
    const root = document.createElement("main");

    const instance = parent.mount(root, {});
    instance.dispose();
    instance.dispose();

    expect(childCleanups).toEqual(["nested"]);
  });
});
