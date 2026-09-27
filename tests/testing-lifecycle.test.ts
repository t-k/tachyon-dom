import { describe, expect, it } from "vitest";
import { compareTemplateLifecycles } from "../src/testing-lifecycle";
import { createRoot, createSignal, effect, onCleanup } from "../src/runtime/signal";

describe("template lifecycle parity", () => {
  const client = {
    templateHtml: "<button>0</button>",
    bind(button: Element, scope: { count: ReturnType<typeof createSignal<number>> }) {
      const click = () => scope.count.update((value) => value + 1);
      button.addEventListener("click", click);
      onCleanup(() => button.removeEventListener("click", click));
      effect(() => { button.textContent = String(scope.count()); });
    },
  };

  it("runs the same interaction against mount and SSR hydration, then disposes both", async () => {
    const visits: string[] = [];
    const disposedVisits: string[] = [];
    const bindingPaths: string[] = [];
    const roots: Element[] = [];
    let serverCleanups = 0;
    const result = await compareTemplateLifecycles<
      { count: ReturnType<typeof createSignal<number>> },
      { text: string | null; count: number }
    >({
      client: {
        ...client,
        bind(root, scope) {
          bindingPaths.push("mount");
          client.bind(root, scope);
        },
        hydrate(root, _hydrationRoot, scope) {
          bindingPaths.push("hydrate");
          client.bind(root, scope);
        },
      },
      createScope: (mode) => {
        if (mode === "server") onCleanup(() => serverCleanups++);
        return { count: createSignal(0) };
      },
      renderServer: (scope) => `<button>${scope.count()}</button>`,
      exercise: (root, _scope, mode) => {
        visits.push(mode);
        expect(root.isConnected).toBe(true);
        expect(root.querySelector("button")?.textContent).toBe("0");
        root.querySelector("button")?.dispatchEvent(new Event("click"));
      },
      observe: (root, scope) => ({ text: root.textContent, count: scope.count() }),
      afterDispose: (root, mode) => {
        disposedVisits.push(mode);
        roots.push(root);
        root.querySelector("button")?.dispatchEvent(new Event("click"));
        expect(root.textContent).toBe("1");
      },
    });
    expect(result).toEqual({ mount: { text: "1", count: 1 }, hydrate: { text: "1", count: 1 } });
    expect(visits).toEqual(["mount", "hydrate"]);
    expect(disposedVisits).toEqual(["mount", "hydrate"]);
    expect(bindingPaths).toEqual(["mount", "hydrate"]);
    expect(serverCleanups).toBe(1);
    expect(roots.every((root) => !root.isConnected)).toBe(true);
  });

  it("reports a behavior difference and still disposes both cases", async () => {
    let cleanups = 0;
    await expect(compareTemplateLifecycles({
      client: {
        ...client,
        bind(root, scope) {
          onCleanup(() => cleanups++);
          client.bind(root, scope);
        },
      },
      createScope: () => ({ count: createSignal(0) }),
      renderServer: () => "<button>0</button>",
      exercise: (root, _scope, mode) => {
        root.querySelector("button")?.dispatchEvent(new Event("click"));
        if (mode === "hydrate") root.querySelector("button")?.dispatchEvent(new Event("click"));
      },
      observe: (root) => root.textContent,
    })).rejects.toThrow(/Lifecycle parity mismatch/);
    expect(cleanups).toBe(2);
  });

  it("releases a mount when an operation throws", async () => {
    let cleanups = 0;
    let afterDispose = 0;
    await expect(compareTemplateLifecycles({
      client: {
        ...client,
        bind(root, scope) {
          onCleanup(() => cleanups++);
          client.bind(root, scope);
        },
      },
      createScope: () => ({ count: createSignal(0) }),
      renderServer: () => "<button>0</button>",
      exercise: (_root, _scope, mode) => {
        if (mode === "mount") throw new Error("operation failed");
      },
      observe: (root) => root.textContent,
      afterDispose: () => { afterDispose++; },
    })).rejects.toThrow("operation failed");
    expect(cleanups).toBe(2);
    expect(afterDispose).toBe(2);
  });

  it("reports reactive work that survives template disposal", async () => {
    const stops: Array<() => void> = [];
    try {
      await expect(compareTemplateLifecycles({
        client,
        createScope: () => ({ count: createSignal(0) }),
        renderServer: () => "<button>0</button>",
        exercise: (_root, scope) => {
          stops.push(effect(() => { scope.count(); }));
        },
        observe: (root) => root.textContent,
      })).rejects.toThrow("Mount and hydrate lifecycles failed.");
    } finally {
      stops.forEach((stop) => stop());
    }
  });

  it("reports an unowned root even when it has no effects", async () => {
    const disposeLeakedRoots: Array<() => void> = [];
    try {
      await expect(compareTemplateLifecycles({
        client,
        createScope: () => ({ count: createSignal(0) }),
        renderServer: () => "<button>0</button>",
        exercise: () => {
          disposeLeakedRoots.push(createRoot((dispose) => dispose));
        },
        observe: (root) => root.textContent,
      })).rejects.toThrow("Mount and hydrate lifecycles failed.");
    } finally {
      disposeLeakedRoots.forEach((dispose) => dispose());
    }
  });

  it("releases a hydrated scope when server markup does not match", async () => {
    let scopeCleanups = 0;
    const disposed: string[] = [];
    await expect(compareTemplateLifecycles({
      client,
      createScope: () => {
        onCleanup(() => scopeCleanups++);
        return { count: createSignal(0) };
      },
      renderServer: () => "<section></section>",
      exercise: () => undefined,
      observe: (root) => root.textContent,
      afterDispose: (_root, mode) => { disposed.push(mode); },
    })).rejects.toThrow(/Hydration structure mismatch/);
    expect(disposed).toEqual(["mount", "hydrate"]);
    expect(scopeCleanups).toBe(3);
  });

  it("continues scope cleanup and post-disposal checks if template cleanup throws", async () => {
    let scopeCleanups = 0;
    let afterDispose = 0;
    await expect(compareTemplateLifecycles({
      client: {
        templateHtml: "<p>ready</p>",
        bind: () => () => { throw new Error("template cleanup failed"); },
      },
      createScope: () => {
        onCleanup(() => scopeCleanups++);
        return {};
      },
      renderServer: () => "<p>ready</p>",
      exercise: () => undefined,
      observe: (root) => root.textContent,
      afterDispose: () => { afterDispose++; },
    })).rejects.toThrow("Mount and hydrate lifecycles failed.");
    expect(scopeCleanups).toBe(3);
    expect(afterDispose).toBe(2);
  });

  it("keeps both operation and cleanup errors", async () => {
    let caught: unknown;
    try {
      await compareTemplateLifecycles({
        client: {
          templateHtml: "<p>ready</p>",
          bind: () => () => { throw new Error("cleanup failed"); },
        },
        createScope: () => ({}),
        renderServer: () => "<p>ready</p>",
        exercise: () => { throw new Error("operation failed"); },
        observe: (root) => root.textContent,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.flatMap((error: AggregateError) =>
      error.errors.map((nested: Error) => nested.message))).toEqual([
      "operation failed",
      "cleanup failed",
      "operation failed",
      "cleanup failed",
    ]);
  });
});
