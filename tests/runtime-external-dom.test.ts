import { describe, expect, it } from "vitest";
import { attachExternalDom } from "../src/runtime/external-dom";
import { createRoot, createSignal, onCleanup } from "../src/runtime/signal";

describe("external DOM ownership", () => {
  it("mounts once, updates the existing instance, and releases it with the parent", () => {
    const options = createSignal({ label: "First" });
    const element = document.createElement("div");
    const calls: string[] = [];
    let handle: ReturnType<typeof attachExternalDom<{ label: string }>> | undefined;
    const disposeParent = createRoot((dispose) => {
      handle = attachExternalDom(element, options, {
        mount(target, initial) {
          calls.push(`mount:${initial.label}`);
          target.textContent = initial.label;
          onCleanup(() => calls.push("owner-cleanup"));
          return {
            update(next) {
              calls.push(`update:${next.label}`);
              target.textContent = next.label;
            },
            dispose() {
              calls.push("dispose");
            },
          };
        },
      });
      return dispose;
    });

    expect(calls).toEqual(["mount:First"]);
    options.set({ label: "Second" });
    expect(calls).toEqual(["mount:First", "update:Second"]);
    expect(element.textContent).toBe("Second");
    disposeParent();
    expect(handle?.disposed()).toBe(true);
    expect(calls).toEqual(["mount:First", "update:Second", "dispose", "owner-cleanup"]);
    options.set({ label: "Third" });
    handle?.dispose();
    expect(calls).toHaveLength(4);
  });

  it("does not track signal reads inside an external adapter", () => {
    const options = createSignal("A");
    const internal = createSignal(0);
    const updates: string[] = [];
    const handle = attachExternalDom(document.createElement("div"), options, {
      mount(_element, initial) {
        internal();
        expect(initial).toBe("A");
        return {
          update(next) {
            internal();
            updates.push(next);
          },
          dispose() {},
        };
      },
    });
    internal.set(1);
    expect(updates).toEqual([]);
    options.set("B");
    expect(updates).toEqual(["B"]);
    handle.dispose();
  });

  it("uses an explicit hydrate adapter to adopt server DOM", () => {
    const element = document.createElement("div");
    element.innerHTML = "<canvas></canvas>";
    const original = element.firstElementChild;
    const calls: string[] = [];
    const handle = attachExternalDom(element, () => 1, {
      mount() {
        throw new Error("mount must not run during hydration");
      },
      hydrate(target, initial) {
        expect(target.firstElementChild).toBe(original);
        calls.push(`hydrate:${initial}`);
        return { update: () => undefined, dispose: () => calls.push("dispose") };
      },
    }, "hydrate");
    expect(element.firstElementChild).toBe(original);
    expect(calls).toEqual(["hydrate:1"]);
    handle.dispose();
    expect(calls).toEqual(["hydrate:1", "dispose"]);
  });

  it("rejects hydration without an adopter and preserves the existing DOM", () => {
    const element = document.createElement("div");
    element.innerHTML = "<canvas></canvas>";
    expect(() => attachExternalDom(element, () => 1, {
      mount() {
        throw new Error("mount should not run");
      },
    }, "hydrate")).toThrow("An external DOM adapter must provide hydrate() to adopt server DOM.");
    expect(element.innerHTML).toBe("<canvas></canvas>");
  });

  it("disposes an instance if adapter initialization fails after registering cleanup", () => {
    const element = document.createElement("div");
    const calls: string[] = [];
    expect(() => attachExternalDom(element, () => 1, {
      mount() {
        onCleanup(() => calls.push("cleanup"));
        throw new Error("failed");
      },
    })).toThrow("failed");
    expect(calls).toEqual(["cleanup"]);
  });
});
