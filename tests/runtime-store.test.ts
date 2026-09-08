import { describe, expect, it } from "vitest";
import { effect } from "../src/runtime/signal";
import { createStore } from "../src/runtime/store";

describe("store runtime", () => {
  it("tracks effects per assigned top-level property", () => {
    const state = createStore({ count: 1, label: "ready" });
    const counts: number[] = [];
    const labels: string[] = [];

    effect(() => {
      counts.push(state.count);
    });
    effect(() => {
      labels.push(state.label);
    });

    state.count = 2;

    expect(counts).toEqual([1, 2]);
    expect(labels).toEqual(["ready"]);
  });
});

it("composes live scopes with enumerable keys and method receivers", async () => {
  const { mergeScopes } = await import("../src/runtime/store");
  const symbol = Symbol("prop");
  const local = { secret: "local", label: "fallback" };
  const input = createStore<Record<PropertyKey, unknown>>({
    label: "input",
    [symbol]: 1,
    method() {
      return this.secret;
    },
  });
  const scope = mergeScopes(local, input);
  const values: unknown[] = [];
  const stop = effect(() => {
    values.push(scope.label, scope.late);
  });
  expect((scope.method as () => unknown)()).toBe("local");
  expect({ ...scope }).toMatchObject({ secret: "local", label: "input", [symbol]: 1 });
  expect("label" in scope).toBe(true);
  expect("secret" in scope).toBe(true);
  expect("missing" in scope).toBe(false);
  expect(Object.getOwnPropertyDescriptor(scope, "missing")).toBeUndefined();
  scope.secret = "changed";
  scope.label = "next";
  scope.late = "added";
  expect(local.secret).toBe("local");
  expect(input.label).toBe("input");
  expect(input.late).toBeUndefined();
  expect(values).toEqual(["input", undefined, "next", undefined, "next", "added"]);
  stop();
});

it("treats prototype-named props as isolated data and does not invoke inherited getters", async () => {
  const { createScopeStore } = await import("../src/runtime/store");
  const input = JSON.parse('{"__proto__":{"injected":true}}');
  const scope = createScopeStore(input, {});
  expect(scope.injected).toBeUndefined();
  expect(scope.__proto__).toEqual({ injected: true });
  expect(scope.injected).toBeUndefined();
  scope.__proto__ = { injected: "written" };
  expect(scope.injected).toBeUndefined();
  expect(input.__proto__).toEqual({ injected: true });
  const inherited = Object.create({
    get secret() {
      throw new Error("Inherited getter read");
    },
  });
  expect(createScopeStore(inherited, {}).secret).toBeUndefined();
});

it("isolates shared default scope assignments while allowing later prop changes", async () => {
  const { mergeScopes } = await import("../src/runtime/store");
  const shared = { label: "default", count: 0 };
  const input = createStore<Record<string, unknown>>({ label: "before" });
  const first = mergeScopes(shared, input);
  const second = mergeScopes(shared, input);
  const values: unknown[] = [];
  const stop = effect(() => {
    values.push(first.label);
  });
  first.label = "local";
  first.count = 7;
  expect(first.label).toBe("local");
  expect(second.label).toBe("before");
  expect(second.count).toBe(0);
  expect(shared.count).toBe(0);
  expect(input.label).toBe("before");
  input.label = "after";
  expect(first.label).toBe("after");
  expect(values).toEqual(["before", "local", "after"]);
  stop();
});

it("does not expose non-enumerable input properties or invoke their getters", async () => {
  const { mergeScopes } = await import("../src/runtime/store");
  const hidden = Object.defineProperty({}, "secret", {
    get() {
      throw new Error("Hidden getter read");
    },
  });
  expect(mergeScopes(hidden, {}).secret).toBeUndefined();
  expect(mergeScopes({ secret: "public" }, hidden).secret).toBe("public");
});

it("reads fresh getter values from multiple effects without re-evaluation loops", async () => {
  const { mergeScopes } = await import("../src/runtime/store");
  let reads = 0;
  const scope = mergeScopes(
    {
      get rows() {
        reads++;
        return ["A"];
      },
    },
    {},
  );
  const seen: number[][] = [[], []];
  let runs = 0;
  const stops = [0, 1].map((index) =>
    effect(() => {
      if (++runs > 20) throw new Error("Scope read caused an effect loop");
      seen[index]!.push((scope.rows as string[]).length);
    }),
  );
  expect(reads).toBe(2);
  expect(seen).toEqual([[1], [1]]);
  for (const stop of stops) stop();
});

it("does not add keys or notify when reading absent scope properties", async () => {
  const { mergeScopes } = await import("../src/runtime/store");
  const scope = mergeScopes({ value: 1 }, {});
  const runs: unknown[] = [];
  const stop = effect(() => {
    runs.push(scope.missing);
  });
  void scope.missing;
  void scope.value;
  expect(Object.keys(scope)).toEqual(["value"]);
  expect("missing" in scope).toBe(false);
  expect(Object.getOwnPropertyDescriptor(scope, "missing")).toBeUndefined();
  expect(runs).toEqual([undefined]);
  scope.missing = "set";
  expect(runs).toEqual([undefined, "set"]);
  expect("missing" in scope).toBe(true);
  stop();
});

it("drops template assignments when the input changes and reports live descriptors", async () => {
  const { createScopeStore } = await import("../src/runtime/store");
  const input = createStore<Record<string, unknown>>({ label: "before" });
  const scope = createScopeStore(input, { local: 0 });
  scope.label = "local";
  expect(Object.getOwnPropertyDescriptor(scope, "label")?.value).toBe("local");
  input.label = "after";
  expect(Object.getOwnPropertyDescriptor(scope, "label")?.value).toBe("after");
  expect(scope.label).toBe("after");
  input.label = "before";
  expect(scope.label).toBe("before");
  scope.local = 5;
  expect(Object.getOwnPropertyDescriptor(scope, "local")?.value).toBe(5);
});

it("lets initial local keys shadow same-named input getters without invoking them", async () => {
  const { createScopeStore } = await import("../src/runtime/store");
  const input = {
    get count() {
      throw new Error("Input getter read for a local key");
    },
  };
  const scope = createScopeStore(input, { count: 1 });
  const values: unknown[] = [];
  const stop = effect(() => {
    values.push(scope.count);
  });
  scope.count = 2;
  expect(values).toEqual([1, 2]);
  expect(Object.getOwnPropertyDescriptor(scope, "count")?.value).toBe(2);
  stop();
});
