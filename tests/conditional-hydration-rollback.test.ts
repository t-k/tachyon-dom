import { describe, expect, it } from "vitest";
import {
  mountConditional,
  mountGeneratedConditional,
  type GeneratedConditionalOptions,
} from "../src/runtime/conditional";
import { setPreparedConditionalNodes } from "../src/runtime/conditional-prepared";
import { createHydrationBoundary, scheduleHydration, type HydrationBoundaryHandle } from "../src/runtime/hydrate";
import { mountKeyedList } from "../src/runtime/list";
import { batch, createRoot, createSignal, effect } from "../src/runtime/signal";

const adoptedBranch = () => {
  const root = document.createElement("main");
  root.innerHTML = `<!----><!--tachyon-hydrate:panel:start--><section><p><!--td:text--></p><button>Save</button><input></section><!--tachyon-hydrate:panel:end-->`;
  const anchor = root.firstChild as Comment;
  const panel = root.querySelector("section")!;
  setPreparedConditionalNodes(anchor, [panel]);
  return { root, panel };
};

describe("conditional hydration transactions", () => {
  it("retains a materialized root text node for later updates and disposal", () => {
    const root = document.createElement("main");
    root.innerHTML = "<!----><!--td:text--><b>tail</b>";
    const anchor = root.firstChild as Comment;
    setPreparedConditionalNodes(anchor, Array.from(root.childNodes).slice(1));
    const value = createSignal("");
    const descriptor: GeneratedConditionalOptions = {
      signature: "root-text",
      templateHtml: " <b>tail</b>",
      bindings: [{ kind: "text", path: [0], read: () => value }],
    };
    const dispose = createRoot((dispose) => {
      effect(() => mountGeneratedConditional(root, [0], true, {}, descriptor));
      return dispose;
    });
    value.set("READY");
    expect(root.textContent).toBe("READYtail");
    value.set("AGAIN");
    expect(root.textContent).toBe("AGAINtail");
    dispose();
    expect(root.childNodes).toHaveLength(1);
    expect(root.firstChild).toBe(anchor);
  });

  it.each(["", null, undefined])("materializes an empty SSR text marker before updating from %s", (initial) => {
    const { root, panel } = adoptedBranch();
    const value = createSignal<string | null | undefined>(initial);
    const descriptor: GeneratedConditionalOptions = {
      signature: "empty-text",
      templateHtml: "<section><p> </p><button>Save</button><input></section>",
      bindings: [{ kind: "text", path: [0, 0], read: () => value }],
      hydrationBoundaries: [{ id: "panel", idKind: "static", path: [], strategy: "interaction", interaction: "click" }],
      hydration: { create: createHydrationBoundary, schedule: scheduleHydration },
    };
    const owner = createRoot((dispose) => {
      effect(() => mountGeneratedConditional(root, [0], true, {}, descriptor));
      return { dispose };
    });
    try {
      expect(panel.querySelector("p")!.firstChild!.nodeType).toBe(8);
      panel.querySelector("button")!.click();
      expect(panel.querySelector("p")!.firstChild!.nodeType).toBe(3);
      value.set("READY");
      expect(panel.querySelector("p")!.textContent).toBe("READY");
      value.set("");
      expect(panel.querySelector("p")!.textContent).toBe("");
      value.set("AGAIN");
      expect(panel.querySelector("p")!.textContent).toBe("AGAIN");
    } finally {
      owner.dispose();
    }
  });

  it.each(["registration", "retracking", "batched retracking"] as const)(
    "rolls back a %s failure before retry and disposal",
    (stage) => {
      const { root, panel } = adoptedBranch();
      panel.querySelector("p")!.textContent = "initial";
      const value = createSignal("initial");
      let reads = 0;
      let clicks = 0;
      let modelEvents = 0;
      let failing = true;
      let boundary: HydrationBoundaryHandle | undefined;
      const failure = new Error(stage);
      const descriptor: GeneratedConditionalOptions = {
        signature: `rollback-${stage}`,
        templateHtml: "<section><p> </p><button>Save</button><input></section>",
        bindings: [
          {
            kind: "text",
            path: [0, 0],
            read: () => {
              reads++;
              if (failing && stage !== "registration" && reads === 2) throw failure;
              return value;
            },
          },
          { kind: "event", path: [1], eventName: "click", read: () => () => clicks++ },
          {
            kind: "model",
            path: [2],
            property: "value",
            read: () => "draft",
            apply: () => {},
            bind: (_scope, element) => {
              if (failing && stage === "registration") throw failure;
              const listener = () => modelEvents++;
              element.addEventListener("input", listener);
              return () => element.removeEventListener("input", listener);
            },
          },
        ],
        hydrationBoundaries: [
          { id: "panel", idKind: "static", path: [], strategy: "interaction", interaction: "focusin" },
        ],
        hydration: {
          create: (...args) => {
            const result = createHydrationBoundary(...args);
            if (result.ok) boundary = result.value;
            return result;
          },
          schedule: scheduleHydration,
        },
      };
      const owner = createRoot((dispose) => {
        effect(() => mountGeneratedConditional(root, [0], true, {}, descriptor));
        return { dispose };
      });
      const button = panel.querySelector("button")!;
      const input = panel.querySelector("input")!;
      try {
        expect(() => (stage === "batched retracking" ? batch(() => boundary!.hydrate()) : boundary!.hydrate())).toThrow(
          failure,
        );
        expect(boundary!.hydrated()).toBe(false);
        button.click();
        input.dispatchEvent(new Event("input"));
        expect(clicks).toBe(0);
        expect(modelEvents).toBe(0);
        const readsAfterFailure = reads;
        value.set("after failure");
        expect(reads).toBe(readsAfterFailure);
        failing = false;
        boundary!.hydrate();
        expect(boundary!.hydrated()).toBe(true);
        expect(panel.querySelector("p")!.textContent).toBe("after failure");
        button.click();
        input.dispatchEvent(new Event("input"));
        expect(clicks).toBe(1);
        expect(modelEvents).toBe(1);
        value.set("updated");
        expect(panel.querySelector("p")!.textContent).toBe("updated");
      } finally {
        owner.dispose();
      }
      button.click();
      input.dispatchEvent(new Event("input"));
      value.set("disposed");
      expect(clicks).toBe(1);
      expect(modelEvents).toBe(1);
      expect(panel.querySelector("p")!.textContent).toBe("updated");
    },
  );
  it.each(["list", "if"] as const)("rolls back a nested %s before a later reader fails", (kind) => {
    const { root, panel } = adoptedBranch();
    panel.innerHTML = "<div><!----></div><p>initial</p>";
    let failing = true;
    let clicks = 0;
    let oldButton: HTMLButtonElement | null = null;
    let boundary: HydrationBoundaryHandle | undefined;
    const nestedBindings = [
      { kind: "event" as const, path: [] as number[], eventName: "click", read: () => () => clicks++ },
    ];
    const child =
      kind === "list"
        ? {
            kind: "list" as const,
            path: [0],
            each: "rows",
            key: "row.id",
            itemName: "row",
            templateHtml: "<button>Child</button>",
            bindings: nestedBindings,
            read: () => [{ id: "one" }],
            mount: mountKeyedList,
          }
        : {
            kind: "if" as const,
            path: [0, 0],
            test: "shown",
            templateHtml: "<button>Child</button>",
            bindings: nestedBindings,
            read: () => true,
            mount: mountConditional,
          };
    const descriptor: GeneratedConditionalOptions = {
      signature: `nested-${kind}`,
      templateHtml: "<section></section>",
      bindings: [
        child,
        {
          kind: "text",
          path: [1, 0],
          read: () => {
            oldButton = panel.querySelector("button");
            if (failing) throw new Error("later reader");
            return "ready";
          },
        },
      ],
      hydrationBoundaries: [
        { id: "panel", idKind: "static", path: [], strategy: "interaction", interaction: "focusin" },
      ],
      hydration: {
        create: (...args) => {
          const result = createHydrationBoundary(...args);
          if (result.ok) boundary = result.value;
          return result;
        },
        schedule: scheduleHydration,
      },
    };
    const dispose = createRoot((dispose) => {
      effect(() => mountGeneratedConditional(root, [0], true, {}, descriptor));
      return dispose;
    });
    try {
      expect(() => boundary!.hydrate()).toThrow("later reader");
      expect(oldButton).not.toBeNull();
      (oldButton as unknown as HTMLButtonElement).click();
      expect(clicks).toBe(0);
      failing = false;
      boundary!.hydrate();
      panel.querySelector("button")!.click();
      expect(clicks).toBe(1);
    } finally {
      dispose();
    }
    (oldButton as unknown as HTMLButtonElement).click();
    expect(clicks).toBe(1);
  });

  it.each([false, true])(
    "releases the latest retracked ref and preserves the original failure (throwing cleanup: %s)",
    (throwCleanup) => {
      const { root, panel } = adoptedBranch();
      panel.querySelector("p")!.textContent = "initial";
      let current: Element | undefined;
      let clears = 0;
      const refs = {
        get panel() {
          return current;
        },
        set panel(value: Element | undefined) {
          current = value;
          if (value === undefined) {
            clears++;
            if (throwCleanup && clears === 2) throw new Error("cleanup failure");
          }
        },
      };
      let reads = 0;
      let clicks = 0;
      let failing = true;
      let boundary: HydrationBoundaryHandle | undefined;
      const failure = new Error("retracking failure");
      const descriptor: GeneratedConditionalOptions = {
        signature: "ref-retracking",
        templateHtml: "<section></section>",
        bindings: [
          { kind: "ref", path: [], owner: () => refs, property: "panel" },
          {
            kind: "text",
            path: [0, 0],
            read: () => {
              if (++reads === 2 && failing) throw failure;
              return "ready";
            },
          },
          { kind: "event", path: [1], eventName: "click", read: () => () => clicks++ },
        ],
        hydrationBoundaries: [
          { id: "panel", idKind: "static", path: [], strategy: "interaction", interaction: "focusin" },
        ],
        hydration: {
          create: (...args) => {
            const result = createHydrationBoundary(...args);
            if (result.ok) boundary = result.value;
            return result;
          },
          schedule: scheduleHydration,
        },
      };
      const dispose = createRoot((dispose) => {
        effect(() => mountGeneratedConditional(root, [0], true, {}, descriptor));
        return dispose;
      });
      try {
        expect(() => boundary!.hydrate()).toThrow(failure);
        expect(refs.panel).toBeUndefined();
        panel.querySelector("button")!.click();
        expect(clicks).toBe(0);
        failing = false;
        boundary!.hydrate();
        expect(refs.panel).toBe(panel);
        panel.querySelector("button")!.click();
        expect(clicks).toBe(1);
      } finally {
        dispose();
      }
      expect(refs.panel).toBeUndefined();
    },
  );
});
