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
