import fc, { type Command } from "fast-check";
import { describe, expect, it } from "vitest";
import { mountConditional } from "../src/runtime/conditional";
import { mountKeyedList } from "../src/runtime/list";
import { createResource, createRoot, createSignal, effect, onCleanup } from "../src/runtime/signal";
import { cleanupOwnedSubtree, registerOwnedSubtree } from "../src/runtime/subtree";
import { propertyParameters } from "./fast-check-config";

type Model = {
  created: boolean;
  disposed: boolean;
  items: string[];
  conditionalVisible: boolean;
  effectRuns: number;
  latestGeneration: number;
  committedGeneration: number;
  cleanupThrowDone: boolean;
  disposeCount: number;
};

type Real = {
  root: HTMLElement;
  liveEffects: number;
  conditionalRoot: HTMLElement;
  conditionalOptions: { templateHtml: string; bindings: [] };
  effectTrigger: ReturnType<typeof createSignal<number>>;
  effectRuns: number;
  ownerDispose: () => void;
  asyncGeneration: number;
  committedGeneration: number;
  cleanupThrowRoot: HTMLElement;
  cleanupThrowRuns: number;
  cleanupAfterThrowRuns: number;
  disposeCount: number;
  options: ReturnType<typeof listOptions>;
  identities: Map<string, Element>;
};

const listOptions = () => ({
  key: "item.id",
  itemName: "item",
  templateHtml: `<li data-key=" "> </li>`,
  bindings: [
    {
      kind: "attr" as const,
      path: [],
      name: "data-key",
      expression: "item.id",
      read: (scope: Record<string, unknown>) => (scope.item as { id: string }).id,
    },
    {
      kind: "text" as const,
      path: [0],
      expression: "item.id",
      read: (scope: Record<string, unknown>) => {
        const real = scope.__real as Real;
        real.liveEffects++;
        onCleanup(() => {
          real.liveEffects--;
        });
        return (scope.item as { id: string }).id;
      },
    },
  ],
});

const valuesFor = (items: readonly string[]) => items.map((id) => ({ id }));

const apply = (real: Real, items: readonly string[]): void => {
  mountKeyedList(
    real.root,
    [],
    valuesFor(items).map((item) => ({ ...item, __real: real })),
    {
      ...real.options,
      scope: { __real: real },
    },
  );
};

const assertRealState = (model: Model, real: Real): void => {
  const elements = Array.from(real.root.children);
  for (const id of real.identities.keys()) {
    if (!model.items.includes(id)) real.identities.delete(id);
  }
  expect(elements.map((element) => element.textContent)).toEqual(model.items);
  expect(elements.map((element) => element.getAttribute("data-key"))).toEqual(model.items);
  for (const [index, id] of model.items.entries()) {
    const element = elements[index] as Element;
    const previous = real.identities.get(id);
    if (previous) expect(element).toBe(previous);
    real.identities.set(id, element);
  }
  expect(real.liveEffects).toBeLessThanOrEqual(model.items.length);
  expect(real.effectRuns).toBe(model.effectRuns);
  expect(real.conditionalRoot.querySelector("span") !== null).toBe(model.conditionalVisible && !model.disposed);
  expect(real.committedGeneration).toBe(model.committedGeneration);
  expect(real.disposeCount).toBe(model.disposeCount);
  if (model.disposed) {
    expect(elements).toHaveLength(0);
    expect(real.liveEffects).toBe(0);
  }
};

const command = (
  name: string,
  check: (model: Readonly<Model>) => boolean,
  run: (model: Model, real: Real) => void,
): Command<Model, Real> => ({ check, run, toString: () => name });

const disposeAll = (real: Real): void => {
  cleanupOwnedSubtree(real.root);
  cleanupOwnedSubtree(real.conditionalRoot);
  cleanupOwnedSubtree(real.cleanupThrowRoot);
  real.ownerDispose();
  real.disposeCount++;
};

const commitAsyncGeneration = (real: Real, generation: number): void => {
  if (generation === real.asyncGeneration) real.committedGeneration = generation;
};

const idsArbitrary = fc
  .array(fc.integer({ min: 0, max: 8 }), { maxLength: 6 })
  .map((ids) => [...new Set(ids.map(String))]);

const commandsArbitrary = fc.commands<Model, Real>(
  [
    fc.constant(
      command(
        "create",
        (model) => !model.created && !model.disposed,
        (model, real) => {
          model.created = true;
          model.items = ["0", "1"];
          apply(real, model.items);
          assertRealState(model, real);
        },
      ),
    ),
    idsArbitrary.map((items) =>
      command(
        `update(${items.join(",")})`,
        (model) => model.created && !model.disposed,
        (model, real) => {
          model.items = items;
          apply(real, model.items);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "reorder",
        (model) => model.created && !model.disposed && model.items.length > 1,
        (model, real) => {
          model.items.reverse();
          apply(real, model.items);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "remove",
        (model) => model.created && !model.disposed && model.items.length > 0,
        (model, real) => {
          model.items = model.items.slice(0, -1);
          apply(real, model.items);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "toggle",
        (model) => model.created && !model.disposed,
        (model, real) => {
          model.items = model.items.length > 0 ? [] : ["toggle"];
          apply(real, model.items);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "effect-rerun",
        (model) => model.created && !model.disposed,
        (model, real) => {
          const before = real.effectRuns;
          real.effectTrigger.update((value) => value + 1);
          model.effectRuns++;
          expect(real.effectRuns).toBe(before + 1);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "if-toggle",
        (model) => model.created && !model.disposed,
        (model, real) => {
          model.conditionalVisible = !model.conditionalVisible;
          mountConditional(real.conditionalRoot, [0], model.conditionalVisible, {}, real.conditionalOptions);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "throw",
        (model) => model.created && !model.disposed,
        (model, real) => {
          const before = real.root.innerHTML;
          expect(() =>
            mountKeyedList(real.root, [], valuesFor(["error"]), {
              ...real.options,
              keyReadItem: () => {
                throw new Error("synthetic row failure");
              },
            }),
          ).toThrow("synthetic row failure");
          expect(real.root.innerHTML).toBe(before);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "async-race",
        (model) => model.created && !model.disposed,
        (model, real) => {
          const firstGeneration = ++real.asyncGeneration;
          const secondGeneration = ++real.asyncGeneration;
          model.latestGeneration = secondGeneration;
          commitAsyncGeneration(real, firstGeneration);
          expect(real.committedGeneration).not.toBe(firstGeneration);
          commitAsyncGeneration(real, secondGeneration);
          model.committedGeneration = secondGeneration;
          const next = model.items.length > 0 ? [model.items[0] as string] : ["race"];
          apply(real, [...model.items, "race"]);
          model.items = next;
          apply(real, model.items);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "cleanup-throw",
        (model) => model.created && !model.disposed && !model.cleanupThrowDone,
        (model, real) => {
          const throwing = document.createElement("i");
          const safe = document.createElement("b");
          real.cleanupThrowRoot.append(throwing, safe);
          registerOwnedSubtree(throwing, () => {
            real.cleanupThrowRuns++;
            throw new Error("synthetic cleanup failure");
          });
          registerOwnedSubtree(safe, () => {
            real.cleanupAfterThrowRuns++;
          });
          expect(() => cleanupOwnedSubtree(real.cleanupThrowRoot)).toThrow("synthetic cleanup failure");
          expect(real.cleanupThrowRuns).toBe(1);
          expect(real.cleanupAfterThrowRuns).toBe(1);
          model.cleanupThrowDone = true;
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "dispose",
        (model) => model.created && !model.disposed,
        (model, real) => {
          model.disposed = true;
          model.items = [];
          model.conditionalVisible = false;
          model.disposeCount = 1;
          disposeAll(real);
          assertRealState(model, real);
        },
      ),
    ),
    fc.constant(
      command(
        "dispose-again",
        (model) => model.created,
        (model, real) => {
          const effectRuns = real.effectRuns;
          disposeAll(real);
          model.disposed = true;
          model.items = [];
          model.conditionalVisible = false;
          model.disposeCount++;
          real.effectTrigger.set(real.effectRuns + 1);
          expect(real.effectRuns).toBe(effectRuns);
          assertRealState(model, real);
        },
      ),
    ),
  ],
  { maxCommands: 24 },
);

describe("lifecycle state machine", () => {
  it("keeps keyed rows and cleanup ownership consistent for generated operation sequences", () => {
    fc.assert(
      fc.property(commandsArbitrary, (commands) => {
        const root = document.createElement("ul");
        const conditionalRoot = document.createElement("section");
        conditionalRoot.append(document.createComment("conditional"));
        const cleanupThrowRoot = document.createElement("aside");
        const real: Real = {
          root,
          liveEffects: 0,
          conditionalRoot,
          conditionalOptions: { templateHtml: "<span>conditional</span>", bindings: [] },
          effectTrigger: createSignal(0),
          effectRuns: 0,
          ownerDispose: () => undefined,
          asyncGeneration: 0,
          committedGeneration: 0,
          cleanupThrowRoot,
          cleanupThrowRuns: 0,
          cleanupAfterThrowRuns: 0,
          disposeCount: 0,
          options: listOptions(),
          identities: new Map(),
        };
        createRoot((dispose) => {
          real.ownerDispose = dispose;
          real.effectTrigger = createSignal(0);
          effect(() => {
            real.effectTrigger();
            real.effectRuns++;
          });
          mountConditional(real.conditionalRoot, [0], true, {}, real.conditionalOptions);
        });
        const model: Model = {
          created: false,
          disposed: false,
          items: [],
          conditionalVisible: true,
          effectRuns: 1,
          latestGeneration: 0,
          committedGeneration: 0,
          cleanupThrowDone: false,
          disposeCount: 0,
        };
        fc.modelRun(() => ({ model, real }), commands);
        if (!model.disposed) {
          cleanupOwnedSubtree(root);
          cleanupOwnedSubtree(conditionalRoot);
          cleanupOwnedSubtree(cleanupThrowRoot);
          real.ownerDispose();
        }
        expect(real.liveEffects).toBe(0);
      }),
      propertyParameters({ seed: 0x25_09_05, numRuns: 80 }),
    );
  });

  it("rejects stale asynchronous generations after a newer result and disposal", async () => {
    const key = createSignal("first");
    const resolve = new Map<string, (value: string) => void>();
    const resource = createResource(key, (value) => new Promise<string>((done) => resolve.set(value, done)));

    await Promise.resolve();
    key.set("second");
    await Promise.resolve();
    resolve.get("second")?.("SECOND");
    await resource.refetch();
    resolve.get("first")?.("STALE");
    await Promise.resolve();

    expect(resource.data()).toBe("SECOND");
    resource.dispose();
    key.set("third");
    expect(resource.loading()).toBe(false);
  });

  it("does not retain a rerun after cleanup disposes its owner", () => {
    fc.assert(
      fc.property(fc.boolean(), (throwsFromCleanup) => {
        const source = createSignal(0);
        let runs = 0;
        let cleanupRuns = 0;
        let siblingRuns = 0;
        const disposeRoot = createRoot((dispose) => {
          effect(() => {
            source();
            runs++;
            return () => {
              cleanupRuns++;
              dispose();
              if (throwsFromCleanup) throw new Error("property cleanup failed");
            };
          });
          effect(() => {
            source();
            siblingRuns++;
          });
          return dispose;
        });

        if (throwsFromCleanup) {
          expect(() => source.set(1)).toThrow("property cleanup failed");
        } else {
          expect(() => source.set(1)).not.toThrow();
        }
        expect(runs).toBe(1);
        expect(cleanupRuns).toBe(1);
        expect(siblingRuns).toBe(1);
        expect(() => disposeRoot()).not.toThrow();
      }),
      propertyParameters({ seed: 0x25_09_06, numRuns: 2 }),
    );
  });
});
