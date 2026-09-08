import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  mountGeneratedConditional,
  mountConditional,
  type GeneratedConditionalOptions,
} from "../src/runtime/conditional";
import { mountKeyedList } from "../src/runtime/list";
import { setPreparedConditionalNodes } from "../src/runtime/conditional-prepared";
import { createHydrationBoundary, scheduleHydration, type HydrationBoundaryHandle } from "../src/runtime/hydrate";
import { batch, catchError, createRoot, createSignal, effect } from "../src/runtime/signal";

type Binding = GeneratedConditionalOptions["bindings"][number];
const fixture = (
  bindings: Binding[],
  boundaries: NonNullable<GeneratedConditionalOptions["hydrationBoundaries"]>,
  onError?: (error: unknown) => void,
  html?: string,
) => {
  const root = document.createElement("main");
  root.innerHTML =
    html ??
    `<!----><section><button>outside</button><!--tachyon-hydrate:a:start--><article><button>A</button><p>A0</p></article><!--tachyon-hydrate:a:end--><!--tachyon-hydrate:b:start--><aside><button>B</button><p>B0</p></aside><!--tachyon-hydrate:b:end--></section>`;
  const panel = root.querySelector("section")!;
  setPreparedConditionalNodes(root.firstChild as Comment, [panel]);
  const handles = new Map<string, HydrationBoundaryHandle>();
  const revision = createSignal(0);
  const descriptor: GeneratedConditionalOptions = {
    signature: "two-boundaries",
    templateHtml: "<section></section>",
    bindings,
    hydrationBoundaries: boundaries,
    hydration: {
      create: (...args) => {
        const result = createHydrationBoundary(...args);
        if (result.ok) handles.set(args[1], result.value);
        return result;
      },
      schedule: scheduleHydration,
    },
  };
  const dispose = createRoot((dispose) => {
    const update = () => {
      revision();
      mountGeneratedConditional(root, [0], true, {}, descriptor);
    };
    if (onError) catchError(update, onError);
    else effect(update);
    return dispose;
  });
  return { root, panel, handles, dispose, rerun: () => revision.update((value) => value + 1) };
};
const boundaries = [
  { id: "a", idKind: "static" as const, path: [1], strategy: "interaction" as const, interaction: "focusin" },
  { id: "b", idKind: "static" as const, path: [2], strategy: "interaction" as const, interaction: "focusin" },
];

describe("independent conditional hydration boundary contracts", () => {
  it("keeps eager bindings active while independently hydrating and disposing sibling boundaries", () => {
    const values = [createSignal("A1"), createSignal("B1")];
    const clicks: [number, number, number] = [0, 0, 0];
    const f = fixture(
      [
        { kind: "event", path: [0], eventName: "click", read: () => () => clicks[0]++ },
        { kind: "event", path: [1, 0], eventName: "click", read: () => () => clicks[1]++ },
        { kind: "text", path: [1, 1, 0], read: () => values[0] },
        { kind: "event", path: [2, 0], eventName: "click", read: () => () => clicks[2]++ },
        { kind: "text", path: [2, 1, 0], read: () => values[1] },
      ],
      boundaries,
    );
    try {
      const [outside, a, b] = Array.from(f.panel.querySelectorAll("button"));
      f.handles.get("a")!.hydrate();
      outside!.click();
      a!.click();
      b!.click();
      expect(clicks).toEqual([1, 1, 0]);
      expect(f.panel.querySelector("article p")!.textContent).toBe("A1");
      expect(f.panel.querySelector("aside p")!.textContent).toBe("B0");
      f.handles.get("b")!.hydrate();
      f.handles.get("a")!.dispose();
      values[0]!.set("A2");
      values[1]!.set("B2");
      f.rerun();
      expect(f.panel.querySelector("article p")!.textContent).toBe("A1");
      expect(f.panel.querySelector("aside p")!.textContent).toBe("B2");
      outside!.click();
      a!.click();
      b!.click();
      expect(clicks).toEqual([2, 1, 1]);
      f.handles.get("a")!.hydrate();
      a!.click();
      expect(clicks).toEqual([2, 2, 1]);
      expect(f.panel.querySelector("article p")!.textContent).toBe("A2");
    } finally {
      f.dispose();
    }
  });

  it("does not roll back an already committed boundary when a later update fails", () => {
    let fail = false;
    let clicks = 0;
    const f = fixture(
      [
        { kind: "event", path: [1, 0], eventName: "click", read: () => () => clicks++ },
        {
          kind: "text",
          path: [2, 1, 0],
          read: () => {
            if (fail) throw new Error("later");
            return "B1";
          },
        },
      ],
      boundaries,
    );
    try {
      f.handles.get("a")!.hydrate();
      f.handles.get("b")!.hydrate();
      fail = true;
      expect(f.rerun).toThrow("later");
      expect(f.handles.get("a")!.hydrated()).toBe(true);
      f.panel.querySelector("article button")!.dispatchEvent(new MouseEvent("click"));
      expect(clicks).toBe(1);
    } finally {
      f.dispose();
    }
  });

  it("preserves the failure consumed by an error handler and rolls back the boundary", () => {
    const failure = new Error("consumed by catchError");
    const errors: unknown[] = [];
    let reads = 0;
    let clicks = 0;
    const f = fixture(
      [
        {
          kind: "text",
          path: [1, 1, 0],
          read: () => {
            if (++reads === 2) throw failure;
            return "A1";
          },
        },
        { kind: "event", path: [1, 0], eventName: "click", read: () => () => clicks++ },
      ],
      boundaries.slice(0, 1),
      (error) => errors.push(error),
    );
    try {
      expect(() => f.handles.get("a")!.hydrate()).toThrow(failure);
      expect(errors).toEqual([failure]);
      expect(f.handles.get("a")!.hydrated()).toBe(false);
      f.panel.querySelector("article button")!.dispatchEvent(new MouseEvent("click"));
      expect(clicks).toBe(0);
      f.handles.get("a")!.hydrate();
      f.panel.querySelector("article button")!.dispatchEvent(new MouseEvent("click"));
      expect(clicks).toBe(1);
    } finally {
      f.dispose();
    }
  });

  it("rolls back all pending boundaries in a batch when subscription handoff fails", () => {
    let reads = 0;
    const clicks: [number, number] = [0, 0];
    const f = fixture(
      [
        { kind: "event", path: [1, 0], eventName: "click", read: () => () => clicks[0]++ },
        { kind: "event", path: [2, 0], eventName: "click", read: () => () => clicks[1]++ },
        {
          kind: "text",
          path: [2, 1, 0],
          read: () => {
            if (++reads === 2) throw new Error("batch");
            return "B1";
          },
        },
      ],
      boundaries,
    );
    try {
      expect(() =>
        batch(() => {
          f.handles.get("a")!.hydrate();
          f.handles.get("b")!.hydrate();
        }),
      ).toThrow("batch");
      expect([...f.handles.values()].map((handle) => handle.hydrated())).toEqual([false, false]);
      f.panel.querySelector("article button")!.dispatchEvent(new MouseEvent("click"));
      f.panel.querySelector("aside button")!.dispatchEvent(new MouseEvent("click"));
      expect(clicks).toEqual([0, 0]);
    } finally {
      f.dispose();
    }
  });

  it("finds a boundary in a fragment-owned branch and defaults an omitted boundary path to its root", () => {
    const fragment = document.createDocumentFragment();
    const anchor = document.createComment("");
    const panel = document.createElement("section");
    panel.innerHTML = `<!--tachyon-hydrate:panel:start--><button>Save</button><!--tachyon-hydrate:panel:end-->`;
    fragment.append(anchor, panel);
    setPreparedConditionalNodes(anchor, [panel]);
    let clicks = 0;
    const descriptor: GeneratedConditionalOptions = {
      signature: "fragment",
      templateHtml: "<section></section>",
      bindings: [{ kind: "event", path: [0], eventName: "click", read: () => () => clicks++ }],
      hydrationBoundaries: [{ id: "panel", idKind: "static", strategy: "interaction", interaction: "focusin" }],
      hydration: { create: createHydrationBoundary, schedule: scheduleHydration },
    };
    const dispose = createRoot((dispose) => {
      effect(() => mountGeneratedConditional(fragment, [0], true, {}, descriptor));
      return dispose;
    });
    try {
      const button = panel.querySelector("button")!;
      button.click();
      expect(clicks).toBe(0);
      button.dispatchEvent(new Event("focusin", { bubbles: true }));
      button.click();
      expect(clicks).toBe(1);
    } finally {
      dispose();
    }
    expect(fragment.childNodes).toHaveLength(1);
  });

  it.each(["missing", "duplicate"])("distinguishes %s markers when creating a boundary", (kind) => {
    const root = document.createElement("main");
    root.innerHTML = "<!---->";
    let clicks = 0;
    const descriptor: GeneratedConditionalOptions = {
      signature: kind,
      templateHtml:
        kind === "missing"
          ? "<button>Save</button>"
          : `<section><!--tachyon-hydrate:panel:start--><button>Save</button><!--tachyon-hydrate:panel:end--><!--tachyon-hydrate:panel:start--><button>Other</button><!--tachyon-hydrate:panel:end--></section>`,
      bindings: [
        { kind: "event", path: kind === "missing" ? [] : [0], eventName: "click", read: () => () => clicks++ },
      ],
      hydrationBoundaries: [{ id: "panel", idKind: "static", path: [], strategy: "interaction", interaction: "click" }],
      hydration: { create: createHydrationBoundary, schedule: scheduleHydration },
    };
    try {
      const run = () => mountGeneratedConditional(root, [0], true, {}, descriptor);
      if (kind === "duplicate") expect(run).toThrow("Duplicate hydrate boundary markers");
      else {
        run();
        root.querySelector("button")!.click();
        expect(clicks).toBe(1);
      }
    } finally {
      mountGeneratedConditional(root, [0], false, {}, descriptor);
    }
  });
});

it("tracks a materialized second root text through updates and branch removal", () => {
  const root = document.createElement("main");
  root.innerHTML = "<!----><span>prefix</span><!--td:text-->";
  setPreparedConditionalNodes(root.firstChild as Comment, Array.from(root.childNodes).slice(1));
  const value = createSignal("");
  const descriptor: GeneratedConditionalOptions = {
    signature: "second-root",
    templateHtml: "<span>prefix</span><!--td:text-->",
    bindings: [{ kind: "text", path: [1], read: () => value }],
  };
  const dispose = createRoot((dispose) => {
    effect(() => mountGeneratedConditional(root, [0], true, {}, descriptor));
    return dispose;
  });
  try {
    value.set("first");
    expect(root.textContent).toBe("prefixfirst");
    value.set("second");
    expect(root.textContent).toBe("prefixsecond");
  } finally {
    dispose();
  }
  expect(root.childNodes).toHaveLength(1);
  expect(root.textContent).toBe("");
});

it("does not evaluate a list whose target is not an element", () => {
  const root = document.createElement("main");
  root.innerHTML = "<!---->";
  let reads = 0;
  const descriptor: GeneratedConditionalOptions = {
    signature: "invalid-list-target",
    templateHtml: "<!---->",
    bindings: [
      {
        kind: "list",
        path: [],
        each: "rows",
        key: "row.id",
        itemName: "row",
        templateHtml: "<p></p>",
        bindings: [],
        read: () => {
          reads++;
          return [];
        },
        mount: mountKeyedList,
      },
    ],
  };
  try {
    mountGeneratedConditional(root, [0], true, {}, descriptor);
    expect(reads).toBe(0);
  } finally {
    mountGeneratedConditional(root, [0], false, {}, descriptor);
  }
});

it("releases a disposed boundary ref without consulting it again on branch disposal", () => {
  let target: unknown;
  let gets = 0;
  const refs = {
    get current() {
      gets++;
      return target;
    },
    set current(value: unknown) {
      target = value;
    },
  };
  const f = fixture([{ kind: "ref", path: [1], owner: () => refs, property: "current" }], boundaries.slice(0, 1));
  f.handles.get("a")!.hydrate();
  expect(target).toBe(f.panel.querySelector("article"));
  f.handles.get("a")!.dispose();
  expect(target).toBeUndefined();
  const before = gets;
  f.dispose();
  expect(gets).toBe(before);
});

const nestedHtml = `<!----><section><!--tachyon-hydrate:a:start--><article><p>outer</p><!--tachyon-hydrate:b:start--><aside><button>B</button><p>inner</p></aside><!--tachyon-hydrate:b:end--></article><!--tachyon-hydrate:a:end--></section>`;
const nestedBoundaries = [
  { ...boundaries[0]!, path: [0] },
  { ...boundaries[1]!, path: [0, 1] },
];
const nestedFixture = () => {
  const outerValue = createSignal("outer ready");
  const innerValue = createSignal("inner ready");
  const refs: { current?: Element } = {};
  let clicks = 0;
  const f = fixture(
    [
      { kind: "text", path: [0, 0, 0], read: () => outerValue },
      { kind: "event", path: [0, 1, 0], eventName: "click", read: () => () => clicks++ },
      { kind: "text", path: [0, 1, 1, 0], read: () => innerValue },
      { kind: "ref", path: [0, 1], owner: () => refs, property: "current" },
    ],
    nestedBoundaries,
    undefined,
    nestedHtml,
  );
  const button = f.panel.querySelector("button") as HTMLButtonElement;
  const texts = () => Array.from(f.panel.querySelectorAll("p"), (p) => p.textContent);
  return { ...f, outerValue, innerValue, refs, button, texts, clicks: () => clicks };
};

describe("nested hydration boundaries own their bindings exclusively", () => {
  it.each([
    ["outer then inner", ["a", "b"]],
    ["inner then outer", ["b", "a"]],
  ] as const)("fires a nested event binding once per click when hydrated %s", (_, order) => {
    const f = nestedFixture();
    try {
      for (const id of order) f.handles.get(id)!.hydrate();
      expect(f.texts()).toEqual(["outer ready", "inner ready"]);
      f.button.click();
      expect(f.clicks()).toBe(1);
      expect(f.refs.current).toBe(f.panel.querySelector("aside"));
      for (const id of order) f.handles.get(id)!.dispose();
      f.button.click();
      expect(f.clicks()).toBe(1);
      expect(f.refs.current).toBeUndefined();
    } finally {
      f.dispose();
    }
  });

  it("leaves the inner boundary inert until it hydrates on its own", () => {
    const f = nestedFixture();
    try {
      f.handles.get("a")!.hydrate();
      f.button.click();
      expect(f.clicks()).toBe(0);
      expect(f.texts()).toEqual(["outer ready", "inner"]);
      expect(f.refs.current).toBeUndefined();
      f.handles.get("b")!.hydrate();
      f.button.click();
      expect(f.clicks()).toBe(1);
      expect(f.texts()).toEqual(["outer ready", "inner ready"]);
    } finally {
      f.dispose();
    }
  });

  it("preserves outer boundary subscriptions when the nested boundary is disposed first", () => {
    const f = nestedFixture();
    try {
      f.handles.get("a")!.hydrate();
      f.handles.get("b")!.hydrate();
      f.handles.get("b")!.dispose();
      expect(f.handles.get("a")!.hydrated()).toBe(true);
      expect(f.handles.get("b")!.hydrated()).toBe(false);
      f.button.click();
      expect(f.clicks()).toBe(0);
      f.outerValue.set("outer still active");
      f.innerValue.set("inner detached");
      expect(f.texts()).toEqual(["outer still active", "inner ready"]);
      f.handles.get("b")!.hydrate();
      expect(f.texts()).toEqual(["outer still active", "inner detached"]);
      f.button.click();
      expect(f.clicks()).toBe(1);
      f.handles.get("a")!.dispose();
      expect(() => f.handles.get("b")!.dispose()).not.toThrow();
    } finally {
      f.dispose();
    }
    expect(f.refs.current).toBeUndefined();
  });

  it("preserves inner boundary subscriptions when the outer boundary is disposed first", () => {
    const f = nestedFixture();
    try {
      f.handles.get("b")!.hydrate();
      f.handles.get("a")!.hydrate();
      f.handles.get("a")!.dispose();
      expect(f.handles.get("a")!.hydrated()).toBe(false);
      expect(f.handles.get("b")!.hydrated()).toBe(true);
      f.outerValue.set("outer detached");
      f.innerValue.set("inner still active");
      expect(f.texts()).toEqual(["outer ready", "inner still active"]);
      f.button.click();
      expect(f.clicks()).toBe(1);
      expect(f.refs.current).toBe(f.panel.querySelector("aside"));
      f.handles.get("b")!.dispose();
      f.button.click();
      expect(f.clicks()).toBe(1);
      expect(f.refs.current).toBeUndefined();
    } finally {
      f.dispose();
    }
  });
});

it("releases hydrated refs before eager refs regardless of eager updates", () => {
  let parent: unknown;
  let child: unknown;
  const releases: string[] = [];
  const refs = {
    get parent() {
      return parent;
    },
    set parent(value: unknown) {
      parent = value;
      if (value === undefined) releases.push("parent");
    },
    get child() {
      return child;
    },
    set child(value: unknown) {
      child = value;
      if (value === undefined) releases.push("child");
    },
  };
  const f = fixture(
    [
      { kind: "ref", path: [], owner: () => refs, property: "parent" },
      { kind: "ref", path: [1], owner: () => refs, property: "child" },
    ],
    boundaries.slice(0, 1),
  );
  f.handles.get("a")!.hydrate();
  f.rerun();
  releases.length = 0;
  f.dispose();
  expect(releases).toEqual(["child", "parent"]);
  expect(parent).toBeUndefined();
  expect(child).toBeUndefined();
});

it.each(["list", "if"] as const)("releases eager refs before tearing down nested %s ownership", (kind) => {
  const root = document.createElement("main");
  root.innerHTML = "<!---->";
  let parent: unknown;
  let child: unknown;
  const releases: string[] = [];
  const refs = {
    get parent() {
      return parent;
    },
    set parent(value: unknown) {
      parent = value;
      if (value === undefined) releases.push("parent");
    },
    get child() {
      return child;
    },
    set child(value: unknown) {
      child = value;
      if (value === undefined) releases.push("child");
    },
  };
  const nestedBindings: Binding[] = [{ kind: "ref", path: [], owner: () => refs, property: "child" }];
  const nested: Binding =
    kind === "list"
      ? {
          kind: "list",
          path: [0],
          each: "rows",
          key: "row.id",
          itemName: "row",
          templateHtml: "<button>child</button>",
          bindings: nestedBindings,
          read: () => [{ id: "one" }],
          mount: mountKeyedList,
        }
      : {
          kind: "if",
          path: [0, 0],
          test: "shown",
          templateHtml: "<button>child</button>",
          bindings: nestedBindings,
          read: () => true,
          mount: mountConditional,
        };
  const descriptor: GeneratedConditionalOptions = {
    signature: `eager-cleanup-${kind}`,
    templateHtml: "<section><div><!----></div></section>",
    bindings: [{ kind: "ref", path: [], owner: () => refs, property: "parent" }, nested],
  };
  try {
    mountGeneratedConditional(root, [0], true, {}, descriptor);
    mountGeneratedConditional(root, [0], true, {}, descriptor);
    releases.length = 0;
  } finally {
    mountGeneratedConditional(root, [0], false, {}, descriptor);
  }
  expect(releases).toEqual(["parent", "child"]);
  expect(parent).toBeUndefined();
  expect(child).toBeUndefined();
});

it("binds eager events after a load boundary hydrates synchronously", () => {
  let outside = 0;
  let inside = 0;
  const f = fixture(
    [
      { kind: "event", path: [0], eventName: "click", read: () => () => outside++ },
      { kind: "event", path: [1, 0], eventName: "click", read: () => () => inside++ },
    ],
    [{ ...boundaries[0]!, strategy: "load" }],
  );
  try {
    f.panel.querySelector("button")!.click();
    f.panel.querySelector<HTMLButtonElement>("article button")!.click();
    expect([outside, inside]).toEqual([1, 1]);
  } finally {
    f.dispose();
  }
});

it("preserves a successful retry performed by the subscription error handler", () => {
  const failure = new Error("first handoff");
  let reads = 0;
  let clicks = 0;
  const errors: unknown[] = [];
  const f = fixture(
    [
      {
        kind: "text",
        path: [1, 1, 0],
        read: () => {
          if (++reads === 2) throw failure;
          return "recovered";
        },
      },
      { kind: "event", path: [1, 0], eventName: "click", read: () => () => clicks++ },
    ],
    boundaries.slice(0, 1),
    (error) => {
      errors.push(error);
      f.handles.get("a")!.hydrate();
    },
  );
  try {
    expect(() => f.handles.get("a")!.hydrate()).toThrow(failure);
    expect(errors).toEqual([failure]);
    expect(f.handles.get("a")!.hydrated()).toBe(true);
    f.panel.querySelector<HTMLButtonElement>("article button")!.click();
    expect(clicks).toBe(1);
  } finally {
    f.dispose();
  }
});

it("releases a failed hydration error while the unhydrated branch remains mounted", async () => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  setFlagsFromString("--no-expose-gc");
  let reference: WeakRef<Error> | undefined;
  let reads = 0;
  const f = fixture(
    [
      {
        kind: "text",
        path: [1, 1, 0],
        read: () => {
          if (++reads === 2) {
            const error = new Error("collectable hydration failure");
            reference = new WeakRef(error);
            throw error;
          }
          return "ready";
        },
      },
    ],
    boundaries.slice(0, 1),
  );
  try {
    try {
      f.handles.get("a")!.hydrate();
    } catch (error) {
      expect((error as Error).message).toBe("collectable hydration failure");
    }
    expect(reference).toBeDefined();
    // Cross a job boundary before collecting: WeakRef keeps its target alive in the creating job.
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      collect();
    }
    expect(reference!.deref()).toBeUndefined();
    expect(f.handles.get("a")!.hydrated()).toBe(false);
    expect(f.root.contains(f.panel)).toBe(true);
    f.handles.get("a")!.hydrate();
    expect(f.panel.querySelector("article p")!.textContent).toBe("ready");
  } finally {
    f.dispose();
  }
});

it("detaches eager events before an updated ref is released", () => {
  const root = document.createElement("main");
  root.innerHTML = "<!---->";
  let target: HTMLButtonElement | undefined;
  let clicks = 0;
  const refs = {
    get current() {
      return target;
    },
    set current(value: HTMLButtonElement | undefined) {
      const previous = target;
      target = value;
      if (!value) previous?.click();
    },
  };
  const descriptor: GeneratedConditionalOptions = {
    signature: "eager-ref-release-event",
    templateHtml: "<button>Save</button>",
    bindings: [
      { kind: "ref", path: [], owner: () => refs, property: "current" },
      { kind: "event", path: [], eventName: "click", read: () => () => clicks++ },
    ],
  };
  try {
    mountGeneratedConditional(root, [0], true, {}, descriptor);
    mountGeneratedConditional(root, [0], true, {}, descriptor);
    expect(clicks).toBe(1);
  } finally {
    mountGeneratedConditional(root, [0], false, {}, descriptor);
  }
  expect(clicks).toBe(1);
  expect(target).toBeUndefined();
});

it("does not retain a detached materialized descendant while its branch stays mounted", async () => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  setFlagsFromString("--no-expose-gc");
  const root = document.createElement("main");
  root.innerHTML = "<!----><section><p><!--td:text--></p></section>";
  const panel = root.querySelector("section")!;
  setPreparedConditionalNodes(root.firstChild as Comment, [panel]);
  const descriptor: GeneratedConditionalOptions = {
    signature: "detached-descendant",
    templateHtml: "<section><p><!--td:text--></p></section>",
    bindings: [{ kind: "text", path: [0, 0], read: () => "ready" }],
  };
  try {
    mountGeneratedConditional(root, [0], true, {}, descriptor);
    const detach = () => {
      const paragraph = panel.firstChild as HTMLElement;
      expect(paragraph.textContent).toBe("ready");
      const reference = new WeakRef(paragraph.firstChild!);
      paragraph.remove();
      expect(panel.childNodes).toHaveLength(0);
      return reference;
    };
    const reference = detach();
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      collect();
    }
    expect(reference.deref()).toBeUndefined();
    expect(root.contains(panel)).toBe(true);
  } finally {
    mountGeneratedConditional(root, [0], false, {}, descriptor);
  }
});
