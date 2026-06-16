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
