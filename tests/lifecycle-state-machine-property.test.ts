import fc, { type Command } from "fast-check";
import { describe, expect, it } from "vitest";
import { mountKeyedList } from "../src/runtime/list";
import { onCleanup } from "../src/runtime/signal";
import { cleanupOwnedSubtree } from "../src/runtime/subtree";
import { propertyParameters } from "./fast-check-config";

type Model = {
  created: boolean;
  disposed: boolean;
  items: string[];
};

type Real = {
  root: HTMLElement;
  liveEffects: number;
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
        "compete",
        (model) => model.created && !model.disposed,
        (model, real) => {
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
        "dispose",
        (model) => model.created && !model.disposed,
        (model, real) => {
          model.disposed = true;
          model.items = [];
          cleanupOwnedSubtree(real.root);
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
        const real: Real = { root, liveEffects: 0, options: listOptions(), identities: new Map() };
        const model: Model = { created: false, disposed: false, items: [] };
        fc.modelRun(() => ({ model, real }), commands);
        if (!model.disposed) cleanupOwnedSubtree(root);
        expect(real.liveEffects).toBe(0);
      }),
      propertyParameters({ seed: 0x25_09_05, numRuns: 80 }),
    );
  });
});
