// @vitest-environment jsdom
// Contracts that the hydration mutation campaign found untested: the boundary options a branch or row hands
// to the scheduler, the row boundary id and marker failure paths, and the setup-scope narrowing rules.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountGeneratedConditional, type GeneratedConditionalOptions } from "../src/runtime/conditional";
import { mountGeneratedKeyedList, mountKeyedList, type GeneratedKeyedListOptions } from "../src/runtime/list";
import { setPreparedConditionalNodes } from "../src/runtime/conditional-prepared";
import {
  createHydrationBoundary,
  scheduleHydration,
  type HydrationBoundaryHandle,
  type HydrationScheduleOptions,
} from "../src/runtime/hydrate";
import { createRoot, createSignal, effect } from "../src/runtime/signal";
import { templateScopeIdentifiers, transformSfcScript } from "../src/compiler/sfc";
import { compileTemplate } from "../src/compiler";

type Boundary = NonNullable<GeneratedConditionalOptions["hydrationBoundaries"]>[number];

// jsdom has neither matchMedia nor IntersectionObserver; the real scheduler needs both to accept the media
// and visible strategies. The stubs never fire, so the boundaries stay unhydrated and only the options the
// runtime passed are observed.
const globalsWithStubs = globalThis as unknown as { matchMedia?: unknown; IntersectionObserver?: unknown };
let previousMatchMedia: unknown;
let previousObserver: unknown;
beforeEach(() => {
  previousMatchMedia = globalsWithStubs.matchMedia;
  previousObserver = globalsWithStubs.IntersectionObserver;
  globalsWithStubs.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  globalsWithStubs.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
});
afterEach(() => {
  globalsWithStubs.matchMedia = previousMatchMedia;
  globalsWithStubs.IntersectionObserver = previousObserver;
});

const recordingHydration = () => {
  const scheduled: HydrationScheduleOptions[] = [];
  const handles = new Map<string, HydrationBoundaryHandle>();
  return {
    scheduled,
    handles,
    hydration: {
      create: (...args: Parameters<typeof createHydrationBoundary>) => {
        const result = createHydrationBoundary(...args);
        if (result.ok) handles.set(args[1], result.value);
        return result;
      },
      schedule: (handle: HydrationBoundaryHandle, options?: HydrationScheduleOptions) => {
        if (options) scheduled.push(options);
        return scheduleHydration(handle, options);
      },
    },
  };
};

describe("conditional branch boundary scheduling options", () => {
  const mountBranch = (boundaries: Boundary[]) => {
    const root = document.createElement("main");
    root.innerHTML = `<!----><section><!--tachyon-hydrate:a:start--><article><p>A0</p></article><!--tachyon-hydrate:a:end--><!--tachyon-hydrate:b:start--><aside><p>B0</p></aside><!--tachyon-hydrate:b:end--></section>`;
    setPreparedConditionalNodes(root.firstChild as Comment, [root.querySelector("section") as Element]);
    const recorder = recordingHydration();
    const descriptor: GeneratedConditionalOptions = {
      signature: `options-${boundaries.map((boundary) => boundary.strategy ?? "default").join("-")}`,
      templateHtml: "<section></section>",
      bindings: [
        { kind: "text", path: [0, 0, 0], read: () => "A1" },
        { kind: "text", path: [1, 0, 0], read: () => "B1" },
      ],
      hydrationBoundaries: boundaries,
      hydration: recorder.hydration,
    };
    const dispose = createRoot((dispose) => {
      effect(() => mountGeneratedConditional(root, [0], true, {}, descriptor));
      return dispose;
    });
    return { root, recorder, dispose };
  };

  it("passes the media query and root margin of each boundary to the scheduler and replays interactions", () => {
    const { recorder, dispose } = mountBranch([
      { id: "a", idKind: "static", path: [0], strategy: "media", media: "(min-width: 48rem)" },
      { id: "b", idKind: "static", path: [1], strategy: "visible", rootMargin: "128px" },
    ]);
    try {
      expect(recorder.scheduled).toEqual([
        { strategy: "media", media: "(min-width: 48rem)", replayInteraction: true },
        { strategy: "visible", rootMargin: "128px", replayInteraction: true },
      ]);
    } finally {
      dispose();
    }
  });

  it("schedules a boundary without a strategy on load and one with an interaction by that event", () => {
    const { root, recorder, dispose } = mountBranch([
      { id: "a", idKind: "static", path: [0] },
      { id: "b", idKind: "static", path: [1], strategy: "interaction", interaction: "focusin" },
    ]);
    try {
      expect(recorder.scheduled).toEqual([
        { strategy: "load", replayInteraction: true },
        { strategy: "interaction", interaction: "focusin", replayInteraction: true },
      ]);
      expect(root.querySelector("article p")?.textContent).toBe("A1");
      expect(root.querySelector("aside p")?.textContent).toBe("B0");
    } finally {
      dispose();
    }
  });
});

describe("keyed list row boundary scheduling and adoption failures", () => {
  type Item = { id?: string; label: string; onClick: () => void };
  const rowOptions = (
    boundary: Record<string, unknown>,
    hydration: ReturnType<typeof recordingHydration>["hydration"],
  ) => ({
    signature: `row-${JSON.stringify(boundary)}`,
    key: "item.label",
    itemName: "item",
    templateHtml: `<li><button> </button></li>`,
    bindings: [
      { kind: "text" as const, path: [0, 0], expression: "item.label" },
      {
        kind: "event" as const,
        path: [0],
        eventName: "click",
        handler: "item.onClick",
        read: (scope: Record<string, unknown>) => (scope.item as Item).onClick,
      },
    ],
    hydrationBoundaries: [boundary as never],
    hydration,
  });

  const generatedRowOptions = (
    boundary: Record<string, unknown>,
    hydration: ReturnType<typeof recordingHydration>["hydration"],
  ): GeneratedKeyedListOptions =>
    ({
      signature: `generated-row-${JSON.stringify(boundary)}`,
      key: "item.label",
      itemName: "item",
      keyReadItem: (item: unknown) => (item as Item).label,
      templateHtml: `<li><button> </button></li>`,
      bindings: [{ kind: "text", path: [0, 0], read: (scope: Record<string, unknown>) => (scope.item as Item).label }],
      hydrationBoundaries: [{ ...boundary, idRead: (scope: Record<string, unknown>) => (scope.item as Item).id }],
      hydration,
    }) as unknown as GeneratedKeyedListOptions;

  it("passes each row boundary's media query, root margin, and default strategy to the scheduler", () => {
    for (const [boundary, expected] of [
      [
        { path: [], id: "item.id", idKind: "expression", strategy: "media", media: "print" },
        { strategy: "media", media: "print", replayInteraction: true },
      ],
      [
        { path: [], id: "item.id", idKind: "expression", strategy: "visible", rootMargin: "4px" },
        { strategy: "visible", rootMargin: "4px", replayInteraction: true },
      ],
      [
        { path: [], id: "item.id", idKind: "expression" },
        { strategy: "load", replayInteraction: true },
      ],
    ] as const) {
      const root = document.createElement("ul");
      root.innerHTML = `<!--tachyon-hydrate:a:start--><li><button>Server A</button></li><!--tachyon-hydrate:a:end-->`;
      const recorder = recordingHydration();
      mountGeneratedKeyedList(
        root,
        [],
        [{ id: "a", label: "A", onClick: () => undefined }],
        generatedRowOptions(boundary, recorder.hydration),
        {},
      );
      expect(recorder.scheduled).toEqual([expected]);
      // Only the load strategy hydrates synchronously; the stubbed media and observer strategies never fire.
      expect(root.querySelector("button")?.textContent).toBe(expected.strategy === "load" ? "A" : "Server A");
    }
  });

  it("rejects an adopted server row whose hydrate:id resolves to no value, but binds a client row eagerly", () => {
    const boundary = { path: [], id: "item.id", idKind: "expression" as const, strategy: "interaction" as const };
    const adopted = document.createElement("ul");
    adopted.innerHTML = `<!--tachyon-hydrate:a:start--><li><button>Server A</button></li><!--tachyon-hydrate:a:end-->`;
    const calls: string[] = [];
    const item: Item = { label: "A", onClick: () => calls.push("A") };
    expect(() => mountKeyedList(adopted, [], [item], rowOptions(boundary, recordingHydration().hydration))).toThrow(
      "Hydration boundary for list row A could not be adopted: hydrate:id={item.id} resolved to no value.",
    );

    const fresh = document.createElement("ul");
    mountKeyedList(fresh, [], [item], rowOptions(boundary, recordingHydration().hydration));
    fresh.querySelector("button")?.click();
    expect(calls).toEqual(["A"]);
    expect(fresh.querySelector("button")?.textContent).toBe("A");
  });

  it("rejects an adopted server row whose boundary markers are absent instead of binding it eagerly", () => {
    const boundary = { path: [], id: "item.id", idKind: "expression" as const, strategy: "interaction" as const };
    const root = document.createElement("ul");
    root.innerHTML = `<li><button>Server A</button></li>`;
    expect(() =>
      mountKeyedList(
        root,
        [],
        [{ id: "a", label: "A", onClick: () => undefined }],
        rowOptions(boundary, recordingHydration().hydration),
      ),
    ).toThrow(/Hydration boundary for list row A could not be adopted: /);
    expect(root.querySelector("button")?.textContent).toBe("Server A");
  });
});

describe("conditional anchors and adopted server nodes", () => {
  it("ignores a mount whose path does not address a comment anchor", () => {
    const root = document.createElement("main");
    root.innerHTML = `<section><p>static</p></section>`;
    const descriptor: GeneratedConditionalOptions = {
      signature: "no-anchor",
      templateHtml: "<article></article>",
      bindings: [],
    };
    expect(() => mountGeneratedConditional(root, [0], true, {}, descriptor)).not.toThrow();
    expect(root.innerHTML).toBe(`<section><p>static</p></section>`);
  });

  it("removes the adopted server nodes of a hand-built anchor when the branch mounts hidden", () => {
    const root = document.createElement("main");
    root.innerHTML = `<!----><section><p>server</p></section><footer>after</footer>`;
    setPreparedConditionalNodes(root.firstChild as Comment, [root.querySelector("section") as Element]);
    const descriptor: GeneratedConditionalOptions = {
      signature: "hidden-adoption",
      templateHtml: "<section><p> </p></section>",
      bindings: [{ kind: "text", path: [0, 0], read: () => "client" }],
    };
    mountGeneratedConditional(root, [0], false, {}, descriptor);
    expect(root.innerHTML).toBe(`<!----><footer>after</footer>`);
    mountGeneratedConditional(root, [0], true, {}, descriptor);
    expect(root.innerHTML).toBe(`<!----><section><p>client</p></section><footer>after</footer>`);
  });
});

describe("keyed list row creation failures", () => {
  it("cleans up the bindings of a row whose creation fails", () => {
    const root = document.createElement("ul");
    const label = createSignal("A");
    let reads = 0;
    const options = {
      signature: "row-creation-failure",
      key: "item.id",
      itemName: "item",
      templateHtml: `<li><span> </span><em> </em></li>`,
      bindings: [
        {
          kind: "text" as const,
          path: [0, 0],
          expression: "item.label",
          read: () => {
            reads += 1;
            return label();
          },
        },
        {
          kind: "text" as const,
          path: [1, 0],
          expression: "item.broken",
          read: () => {
            throw new Error("broken row binding");
          },
        },
      ],
    };
    expect(() => mountKeyedList(root, [], [{ id: "a" }], options)).toThrow("broken row binding");
    expect(root.querySelector("li")).toBeNull();
    const readsAfterFailure = reads;
    label.set("B");
    expect(reads).toBe(readsAfterFailure);
  });
});

describe("template scope identifiers", () => {
  it("collects nothing from a blank template and every reference otherwise", () => {
    expect(templateScopeIdentifiers("   ")).toEqual(new Set());
    expect(templateScopeIdentifiers("<p>{label}</p>")).toEqual(new Set(["label"]));
    const compiled = compileTemplate("<p title={hint}>{label}</p>");
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(templateScopeIdentifiers(compiled.value)).toEqual(new Set(["hint", "label"]));
  });

  it("visits the expressions inside template literals", () => {
    expect(templateScopeIdentifiers("<p>{`${first} ${second}`}</p>")).toEqual(new Set(["first", "second"]));
  });

  it("treats a component name as a scope reference but not the static name attribute of an element", () => {
    expect(templateScopeIdentifiers(`<component name="Panel"><p>{label}</p></component>`)).toEqual(
      new Set(["Panel", "label"]),
    );
    expect(templateScopeIdentifiers(`<div name="static">{label}</div>`)).toEqual(new Set(["label"]));
  });
});

describe("setup scope narrowing rules", () => {
  // The transform result is cached by content, and the mutation runner switches mutants inside one process,
  // so every call carries a fresh comment to keep the cache from answering for the previous variant.
  let nonce = 0;
  const emission = (content: string, exposed: string[]) => {
    const transformed = transformSfcScript(
      { attrs: "setup", offset: 0, content: `${content} // ${Date.now()}-${nonce++}` },
      { templateIdentifiers: new Set(exposed) },
    );
    if (!transformed.ok) throw new Error(transformed.error.message);
    return transformed.value;
  };

  it("narrows literal, boolean, null, array, object, and function initializers", () => {
    const value = emission(
      'const flag = true; const off = false; const none = null; const items = []; const opts = {}; const n = 1; const label = () => "x"; function helper() {}',
      ["flag", "off", "none", "items", "opts", "n", "label", "helper"],
    );
    expect(value.scopeEmission).toBe("full");
    expect(value.exposedBindings).toEqual(["flag", "helper", "items", "label", "n", "none", "off", "opts"]);
    const narrowed = emission('const flag = true; const hidden = "h";', ["flag"]);
    expect(narrowed.scopeEmission).toBe("dual");
    expect(narrowed.exposedBindings).toEqual(["flag"]);
  });

  it("reports no setup bindings for a non-setup script", () => {
    const transformed = transformSfcScript(
      { attrs: "", offset: 0, content: "export default () => ({ label: 1 });" },
      { templateIdentifiers: new Set(["label"]) },
    );
    if (!transformed.ok) throw new Error(transformed.error.message);
    expect(transformed.value.setupBindings).toEqual([]);
    expect(transformed.value.exposedBindings).toEqual([]);
    expect(transformed.value.scopeEmission).toBe("full");
  });

  it("keeps the full scope when any exposed binding has a non-static initializer", () => {
    const value = emission('const a = 1; const b = compute(); const hidden = "h";', ["a", "b"]);
    expect(value.scopeEmission).toBe("full");
    expect(value.exposedBindings).toEqual(["a", "b", "hidden"]);
  });

  it("keeps the full scope when the script reads inputScope, uses eval, or assigns with a compound operator", () => {
    for (const content of [
      "const a = 1; const hidden = inputScope;",
      'const a = 1; const hidden = eval("1");',
      "const a = 1; const o = { v: 1 }; o.v ^= 1;",
      "const a = 1; const o = { v: 1 }; o.v = 2;",
      "const a = 1; const hidden = this;",
    ]) {
      const value = emission(content, ["a"]);
      expect(value.scopeEmission, content).toBe("full");
      expect(value.exposedBindings.length, content).toBe(value.setupBindings.length);
    }
    const narrowed = emission("const a = 1; const o = { v: 1 };", ["a"]);
    expect(narrowed.scopeEmission).toBe("dual");
  });
});
