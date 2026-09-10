import { describe, expect, it, vi } from "vitest";
import { compileTemplate, generateClientModule, renderServerTemplate } from "../src/compiler";
import { hydrate, mount, type ClientTemplateModule } from "../src/runtime/mount";
import { createRoot, createSignal, effect, onCleanup, setRuntimeLifecycleHooks } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";
import { tachyonDom } from "../src/vite";
import * as hydrateRuntime from "../src/runtime/hydrate";

describe("client mount entrypoints", () => {
  it("binds generated client modules against the generated template root", () => {
    const compiled = compileTemplate(`<p>{name}</p>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("main");

    mount(root, module, { name: "Alice" });

    expect(root.innerHTML).toBe(`<p>Alice</p>`);
  });

  it("short-circuits optional computed access in Vite SFC client modules", async () => {
    const plugin = tachyonDom();
    if (typeof plugin.transform !== "function") throw new Error("Missing transform hook");
    const result = await plugin.transform.call(
      {
        error(message: string): never {
          throw new Error(message);
        },
      } as never,
      "<p>{user?.[key()](arg())}</p>",
      "/src/optional-computed.td?client",
    );
    if (!result || typeof result !== "object" || typeof result.code !== "string")
      throw new Error("Missing generated module");
    const module = evaluateGeneratedClientModule(result.code);
    const root = document.createElement("main");
    const handle = mount(root, module, {
      user: null,
      key: () => {
        throw new Error("key must not run");
      },
      arg: () => {
        throw new Error("arg must not run");
      },
    });
    expect(root.textContent).toBe("");
    handle.dispose();
  });

  it("uses the lightweight conditional path for generated branches and adopts SSR nodes", () => {
    const compiled = compileTemplate(`<main><if test={visible}><button on:click={save}>{label}</button></if></main>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value, { reactive: true });
    expect(generated).toContain(`from "tachyon-dom/runtime/conditional-core"`);
    expect(generated).not.toContain(`from "tachyon-dom/runtime/conditional"`);
    expect(generated).not.toContain(`from "tachyon-dom/runtime/form"`);
    expect(generated).not.toContain(`from "tachyon-dom/runtime/list"`);
    const module = evaluateGeneratedClientModule(generated);
    const visible = createSignal(false);
    const label = createSignal("client");
    let clicks = 0;
    const scope = { visible, label, save: () => clicks++ };
    const root = document.createElement("div");

    mount(root, module, scope);
    visible.set(true);
    expect(root.querySelector("button")?.textContent).toBe("client");
    root.querySelector("button")?.click();
    visible.set(false);
    expect(root.querySelector("button")).toBeNull();
    visible.set(true);
    root.querySelector("button")?.click();
    expect(clicks).toBe(2);

    const ssrRoot = document.createElement("div");
    ssrRoot.innerHTML = renderServerTemplate(compiled.value, { visible: true, label: "server" });
    const serverButton = ssrRoot.querySelector("button");
    if (!(serverButton instanceof HTMLButtonElement)) throw new Error("Missing SSR button.");
    const hydratedVisible = createSignal(true);
    const hydratedLabel = createSignal("hydrated");
    const hydrated = hydrate(ssrRoot, module, {
      visible: hydratedVisible,
      label: hydratedLabel,
      save: () => clicks++,
    });

    expect(hydrated.ok).toBe(true);
    expect(ssrRoot.querySelector("button")).toBe(serverButton);
    expect(serverButton.textContent).toBe("hydrated");
    hydratedLabel.set("updated");
    expect(serverButton.textContent).toBe("updated");
    serverButton.click();
    hydratedVisible.set(false);
    expect(ssrRoot.querySelector("button")).toBeNull();
    if (hydrated.ok) hydrated.value.dispose();

    const hiddenSsrRoot = document.createElement("div");
    hiddenSsrRoot.innerHTML = renderServerTemplate(compiled.value, { visible: false, label: "hidden" });
    const hiddenVisible = createSignal(false);
    const hiddenHydrated = hydrate(hiddenSsrRoot, module, {
      visible: hiddenVisible,
      label: createSignal("shown later"),
      save: () => clicks++,
    });
    expect(hiddenHydrated.ok).toBe(true);
    hiddenVisible.set(true);
    expect(hiddenSsrRoot.querySelector("button")?.textContent).toBe("shown later");
    if (hiddenHydrated.ok) hiddenHydrated.value.dispose();
  });

  it("keeps adjacent generated conditional branches independent across toggles", () => {
    const compiled = compileTemplate(
      `<main><if test={leftVisible}><button data-branch="left" on:click={saveLeft}>{left}</button></if><if test={rightVisible}><button data-branch="right" on:click={saveRight}>{right}</button></if><footer>Static</footer></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));

    for (const [leftInitiallyVisible, rightInitiallyVisible] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const root = document.createElement("div");
      const leftVisible = createSignal(leftInitiallyVisible);
      const rightVisible = createSignal(rightInitiallyVisible);
      const left = createSignal("A");
      const right = createSignal("B");
      let leftClicks = 0;
      let rightClicks = 0;
      const handle = mount(root, module, {
        leftVisible,
        rightVisible,
        left,
        right,
        saveLeft: () => leftClicks++,
        saveRight: () => rightClicks++,
      });
      const main = root.querySelector("main");
      const footer = main?.querySelector("footer");
      if (!(main instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
        throw new Error("Missing generated conditional root.");
      }

      expect(main.textContent).toBe(`${leftInitiallyVisible ? "A" : ""}${rightInitiallyVisible ? "B" : ""}Static`);
      rightVisible.set(true);
      leftVisible.set(true);
      const firstLeft = main.querySelector(`[data-branch="left"]`);
      const firstRight = main.querySelector(`[data-branch="right"]`);
      expect(main.textContent).toBe("ABStatic");
      expect(main.querySelector("footer")).toBe(footer);

      left.set("A2");
      right.set("B2");
      expect(main.textContent).toBe("A2B2Static");
      leftVisible.set(false);
      expect(main.textContent).toBe("B2Static");
      main.querySelector(`[data-branch="right"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(rightClicks).toBe(1);
      leftVisible.set(true);
      expect(main.textContent).toBe("A2B2Static");
      expect(main.querySelector(`[data-branch="right"]`)).toBe(firstRight);
      expect(main.querySelector(`[data-branch="left"]`)).not.toBe(firstLeft);
      main.querySelector(`[data-branch="left"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(leftClicks).toBe(1);

      rightVisible.set(false);
      leftVisible.set(false);
      expect(main.textContent).toBe("Static");
      rightVisible.set(true);
      expect(main.textContent).toBe("B2Static");
      const finalRight = main.querySelector(`[data-branch="right"]`);
      expect(finalRight).not.toBe(firstRight);
      handle.dispose();
      finalRight?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(rightClicks).toBe(1);
    }
  });

  it("hydrates every adjacent conditional visibility combination without stealing SSR nodes", () => {
    const compiled = compileTemplate(
      `<main><if test={leftVisible}><button data-branch="left">{left}</button></if><if test={rightVisible}><button data-branch="right">{right}</button></if><footer>Static</footer></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));

    for (const [leftInitiallyVisible, rightInitiallyVisible] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const root = document.createElement("div");
      const leftVisible = createSignal(leftInitiallyVisible);
      const rightVisible = createSignal(rightInitiallyVisible);
      const left = createSignal("A");
      const right = createSignal("B");
      root.innerHTML = renderServerTemplate(compiled.value, {
        leftVisible: leftInitiallyVisible,
        rightVisible: rightInitiallyVisible,
        left: "A",
        right: "B",
      });
      const serverLeft = root.querySelector(`[data-branch="left"]`);
      const serverRight = root.querySelector(`[data-branch="right"]`);
      const hydrated = hydrate(root, module, { leftVisible, rightVisible, left, right });
      if (!hydrated.ok) throw new Error(hydrated.error.message);

      expect(root.textContent).toBe(`${leftInitiallyVisible ? "A" : ""}${rightInitiallyVisible ? "B" : ""}Static`);
      expect(root.querySelector(`[data-branch="left"]`)).toBe(leftInitiallyVisible ? serverLeft : null);
      expect(root.querySelector(`[data-branch="right"]`)).toBe(rightInitiallyVisible ? serverRight : null);

      leftVisible.set(!leftInitiallyVisible);
      rightVisible.set(!rightInitiallyVisible);
      expect(root.textContent).toBe(`${leftInitiallyVisible ? "" : "A"}${rightInitiallyVisible ? "" : "B"}Static`);
      hydrated.value.dispose();
    }
  });

  it("preserves a static sibling when a hidden SSR conditional has a different root shape", () => {
    const compiled = compileTemplate(
      `<main><if test={visible}><p data-branch="branch">{label}</p></if><p data-static="yes">{tail}</p></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: false,
      label: "SSR branch",
      tail: "SSR tail",
    });
    const serverStatic = root.querySelector('[data-static="yes"]');
    const visible = createSignal(false);
    const label = createSignal("Client branch");
    const tail = createSignal("Client tail");

    const hydrated = hydrate(root, module, { visible, label, tail });

    expect(hydrated.ok).toBe(true);
    expect(root.querySelector('[data-static="yes"]')).toBe(serverStatic);
    expect(root.textContent).toBe("Client tail");
    tail.set("Client tail 2");
    expect(serverStatic?.textContent).toBe("Client tail 2");
    if (hydrated.ok) hydrated.value.dispose();
  });

  it("preserves an attributed static sibling when the conditional root has no attributes", () => {
    const compiled = compileTemplate(
      `<main><if test={visible}><p>{label}</p></if><p data-static="yes">{tail}</p></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: false,
      label: "SSR branch",
      tail: "SSR tail",
    });
    const serverStatic = root.querySelector('[data-static="yes"]');
    const hydrated = hydrate(root, module, {
      visible: createSignal(false),
      label: createSignal("Client branch"),
      tail: createSignal("Client tail"),
    });

    expect(hydrated.ok).toBe(true);
    expect(root.querySelector('[data-static="yes"]')).toBe(serverStatic);
    expect(root.textContent).toBe("Client tail");
    if (hydrated.ok) hydrated.value.dispose();
  });

  it.each([
    `<main><if test={visible}><p class="shared">{left}</p></if><p class="shared" data-static="yes">{tail}</p></main>`,
    `<main><if test={visible}><section><b>{left}</b></section></if><section><em>{tail}</em></section></main>`,
  ])("keeps a static sibling when conditional adoption differs below the root", (source) => {
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: false,
      left: "SSR branch",
      tail: "SSR tail",
    });
    const main = root.querySelector("main");
    const staticSibling = main?.lastElementChild;
    const visible = createSignal(false);
    const left = createSignal("Client branch");
    const tail = createSignal("Client tail");

    const hydrated = hydrate(root, module, { visible, left, tail });

    expect(hydrated.ok).toBe(true);
    expect(main?.lastElementChild).toBe(staticSibling);
    expect(root.querySelector("main")?.textContent).toBe("Client tail");
    tail.set("Client tail 2");
    expect(staticSibling?.textContent).toBe("Client tail 2");
    if (hydrated.ok) hydrated.value.dispose();
  });

  it.each([
    `<main><if test={visible}><p title={title}>{left}</p></if><p title="static">{tail}</p></main>`,
    `<main><if test={visible}><p class="shared" class:active={active}>{left}</p></if><p class="shared active">{tail}</p></main>`,
    `<main><if test={visible}><p title={title}>{left}</p></if><p title="static" on:click={save}>{tail}</p></main>`,
    `<main><if test={visible}><p class="active" title={title}>{left}</p></if><p class={classes} class:extra={active} title="static">{tail}</p></main>`,
  ])("rejects dynamic conditional shape overlap before changing a static sibling", (source) => {
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(compiled.value.client.hydrationDynamicRegionErrors).toHaveLength(1);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: false,
      title: "branch title",
      active: false,
      classes: "active",
      left: "branch",
      tail: "static",
    });
    const before = root.innerHTML;
    const staticSibling = root.querySelector("main > p");
    let owners = 0;
    let effects = 0;
    let subscriptions = 0;
    let cleanups = 0;
    const restoreHooks = setRuntimeLifecycleHooks({
      ownerCreated: () => owners++,
      effectCreated: () => effects++,
      subscriptionChanged: (delta) => (subscriptions += delta),
      cleanupChanged: (delta) => (cleanups += delta),
    });
    try {
      const result = hydrate(root, module, {
        visible: createSignal(false),
        title: createSignal("client title"),
        active: createSignal(false),
        classes: createSignal("active"),
        left: createSignal("client branch"),
        tail: createSignal("client static"),
        save: () => undefined,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Dynamic conditional shape overlap unexpectedly hydrated.");
      expect(result.error.message).toContain("ambiguous conditional hydration");
    } finally {
      restoreHooks();
    }
    expect(root.innerHTML).toBe(before);
    expect(root.querySelector("main > p")).toBe(staticSibling);
    expect(owners).toBe(0);
    expect(effects).toBe(0);
    expect(subscriptions).toBe(0);
    expect(cleanups).toBe(0);
  });

  it("rejects a conditional whose static sibling has an expression-valued comparison attribute", () => {
    const compiled = compileTemplate(
      `<main><if test={visible}><p title="same" class:active={active}>{left}</p></if><p title={title}>{tail}</p></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(compiled.value.client.hydrationDynamicRegionErrors).toHaveLength(1);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: false,
      title: "same",
      active: false,
      left: "branch",
      tail: "static",
    });
    const before = root.innerHTML;
    const staticSibling = root.querySelector("main > p");
    let owners = 0;
    let effects = 0;
    let subscriptions = 0;
    let cleanups = 0;
    const restoreHooks = setRuntimeLifecycleHooks({
      ownerCreated: () => owners++,
      effectCreated: () => effects++,
      subscriptionChanged: (delta) => (subscriptions += delta),
      cleanupChanged: (delta) => (cleanups += delta),
    });
    try {
      const result = hydrate(root, module, {
        visible: createSignal(false),
        title: createSignal("same"),
        active: createSignal(false),
        left: createSignal("client branch"),
        tail: createSignal("client static"),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expression-valued conditional shape overlap unexpectedly hydrated.");
      expect(result.error.message).toContain("ambiguous conditional hydration");
    } finally {
      restoreHooks();
    }
    expect(root.innerHTML).toBe(before);
    expect(root.querySelector("main > p")).toBe(staticSibling);
    expect(owners).toBe(0);
    expect(effects).toBe(0);
    expect(subscriptions).toBe(0);
    expect(cleanups).toBe(0);
  });

  it("rejects a conditional whose static sibling derives its class from a class directive", () => {
    const compiled = compileTemplate(
      `<main><if test={visible}><p class="active" title="static">{left}</p></if><p class:active={active} title="static">{tail}</p></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(compiled.value.client.hydrationDynamicRegionErrors).toHaveLength(1);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: false,
      active: false,
      left: "branch",
      tail: "static",
    });
    const before = root.innerHTML;
    const staticSibling = root.querySelector("main > p");
    let owners = 0;
    let effects = 0;
    let subscriptions = 0;
    let cleanups = 0;
    const restoreHooks = setRuntimeLifecycleHooks({
      ownerCreated: () => owners++,
      effectCreated: () => effects++,
      subscriptionChanged: (delta) => (subscriptions += delta),
      cleanupChanged: (delta) => (cleanups += delta),
    });
    try {
      const result = hydrate(root, module, {
        visible: createSignal(false),
        active: createSignal(true),
        left: createSignal("client branch"),
        tail: createSignal("client static"),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Class directive conditional shape overlap unexpectedly hydrated.");
      expect(result.error.message).toContain("ambiguous conditional hydration");
    } finally {
      restoreHooks();
    }
    expect(root.innerHTML).toBe(before);
    expect(root.querySelector("main > p")).toBe(staticSibling);
    expect(owners).toBe(0);
    expect(effects).toBe(0);
    expect(subscriptions).toBe(0);
    expect(cleanups).toBe(0);
  });

  it("hydrates a class-directive sibling when its generated token is distinct", () => {
    const compiled = compileTemplate(
      `<main><if test={visible}><p class="active">{left}</p></if><p class:other={active}>{tail}</p></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(compiled.value.client.hydrationDynamicRegionErrors).toHaveLength(0);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: false,
      active: false,
      left: "branch",
      tail: "static",
    });
    const staticSibling = root.querySelector("main > p");
    const visible = createSignal(false);
    const active = createSignal(false);
    const tail = createSignal("client static");

    const result = hydrate(root, module, { visible, active, tail });

    expect(result.ok).toBe(true);
    expect(root.querySelector("main > p")).toBe(staticSibling);
    expect(staticSibling?.className).toBe("");
    expect(staticSibling?.textContent).toBe("client static");
    tail.set("updated static");
    expect(staticSibling?.textContent).toBe("updated static");
    active.set(true);
    expect(staticSibling?.className).toBe("other");
    if (result.ok) result.value.dispose();
  });

  it("hydrates a dynamic conditional root attribute when its sibling shape is distinct", () => {
    const compiled = compileTemplate(
      `<main><if test={visible}><p title={title} class:active={active}>{label}</p></if><footer>{tail}</footer></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: true,
      title: "server title",
      active: false,
      label: "server label",
      tail: "server footer",
    });
    const serverParagraph = root.querySelector("p");
    const visible = createSignal(true);
    const title = createSignal("client title");
    const active = createSignal(false);
    const label = createSignal("client label");
    const tail = createSignal("client footer");

    const result = hydrate(root, module, { visible, title, active, label, tail });

    expect(result.ok).toBe(true);
    expect(root.querySelector("p")).toBe(serverParagraph);
    expect(serverParagraph?.getAttribute("title")).toBe("client title");
    expect(serverParagraph?.classList.contains("active")).toBe(false);
    expect(serverParagraph?.textContent).toBe("client label");
    expect(root.querySelector("footer")?.textContent).toBe("client footer");
    active.set(true);
    expect(serverParagraph?.classList.contains("active")).toBe(true);
    active.set(false);
    expect(serverParagraph?.classList.contains("active")).toBe(false);
    if (result.ok) result.value.dispose();
  });

  it("hydrates an event-bearing sibling when its DOM shape is distinct", () => {
    const source = `<main><if test={visible}><p title={title}>{left}</p></if><button data-static="yes" on:click={save}>{tail}</button></main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(compiled.value.client.hydrationDynamicRegionErrors).toHaveLength(0);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: false,
      title: "branch title",
      left: "branch",
      tail: "static",
    });
    const button = root.querySelector("button");
    const tail = createSignal("static");
    let clicks = 0;
    const result = hydrate(root, module, {
      visible: createSignal(false),
      title: createSignal("client title"),
      left: createSignal("client branch"),
      tail,
      save: () => clicks++,
    });

    expect(result.ok).toBe(true);
    expect(root.querySelector("button")).toBe(button);
    tail.set("updated");
    expect(button?.textContent).toBe("updated");
    button?.click();
    expect(clicks).toBe(1);
    if (result.ok) result.value.dispose();
    button?.click();
    expect(clicks).toBe(1);
  });

  it.each([
    `<main><p data-kind="same">Before</p><if test={visible}><p data-kind="same">{label}</p></if><p data-kind="same">After</p></main>`,
    `<main><if test={leftVisible}><p data-kind="same">{left}</p></if><if test={rightVisible}><p data-kind="same">{right}</p></if><footer>Static</footer></main>`,
  ])("rejects ambiguous conditional adoption before changing same-shaped SSR siblings", (source) => {
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = source.includes("Before")
      ? renderServerTemplate(compiled.value, { visible: false, label: "Client", tail: "ignored" })
      : renderServerTemplate(compiled.value, {
          leftVisible: true,
          rightVisible: false,
          left: "Left",
          right: "Right",
        });
    const before = root.innerHTML;
    const serverNodes = Array.from(root.querySelectorAll('[data-kind="same"]'));
    let owners = 0;
    let effects = 0;
    let subscriptions = 0;
    let cleanups = 0;
    const restoreHooks = setRuntimeLifecycleHooks({
      ownerCreated: () => owners++,
      effectCreated: () => effects++,
      subscriptionChanged: (delta) => (subscriptions += delta),
      cleanupChanged: (delta) => (cleanups += delta),
    });
    try {
      const scope = source.includes("Before")
        ? { visible: createSignal(false), label: createSignal("Client") }
        : {
            leftVisible: createSignal(true),
            rightVisible: createSignal(true),
            left: createSignal("Client left"),
            right: createSignal("Client right"),
          };
      const result = hydrate(root, module, scope);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Ambiguous conditional adoption unexpectedly hydrated.");
      expect(result.error.message).toContain("ambiguous conditional");
    } finally {
      restoreHooks();
    }
    expect(root.innerHTML).toBe(before);
    expect(Array.from(root.querySelectorAll('[data-kind="same"]'))).toEqual(serverNodes);
    expect(owners).toBe(0);
    expect(effects).toBe(0);
    expect(subscriptions).toBe(0);
    expect(cleanups).toBe(0);
  });

  it.each([
    [true, false],
    [false, true],
  ] as const)(
    "reconciles a generated conditional when SSR visibility is %j and client visibility is %j",
    (serverVisible, clientVisible) => {
      const compiled = compileTemplate(`<main><if test={visible}><p>{label}</p></if><footer>{tail}</footer></main>`);
      if (!compiled.ok) throw new Error(compiled.error.message);
      const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
      const root = document.createElement("div");
      root.innerHTML = renderServerTemplate(compiled.value, {
        visible: serverVisible,
        label: "SSR",
        tail: "SSR footer",
      });
      const serverParagraph = root.querySelector("p");
      const serverFooter = root.querySelector("footer");
      const visible = createSignal(clientVisible);
      const label = createSignal("Client");
      const tail = createSignal("Client footer");
      const hydrated = hydrate(root, module, { visible, label, tail });
      if (!hydrated.ok) throw new Error(hydrated.error.message);

      expect(root.querySelector("footer")).toBe(serverFooter);
      if (serverVisible && clientVisible) {
        expect(root.querySelector("p")).toBe(serverParagraph);
      } else if (clientVisible) {
        expect(root.querySelector("p")).not.toBeNull();
      } else {
        expect(root.querySelector("p")).toBeNull();
      }
      expect(root.querySelector("p")?.textContent ?? null).toBe(clientVisible ? "Client" : null);
      expect(serverParagraph?.isConnected ?? false).toBe(serverVisible && clientVisible);
      expect(serverFooter?.textContent).toBe("Client footer");

      tail.set("Client footer 2");
      expect(serverFooter?.textContent).toBe("Client footer 2");
      visible.set(!clientVisible);
      expect(root.querySelector("p")?.textContent ?? null).toBe(clientVisible ? null : "Client");
      visible.set(clientVisible);
      expect(root.querySelector("p")?.textContent ?? null).toBe(clientVisible ? "Client" : null);
      hydrated.value.dispose();
    },
  );

  it.each(
    [
      {
        rows: [],
        serverActive: false,
        clientActive: false,
      },
      {
        rows: [{ id: "a", label: "R1" }],
        serverActive: true,
        clientActive: false,
      },
      {
        rows: [
          { id: "a", label: "R1" },
          { id: "b", label: "R2" },
        ],
        serverActive: false,
        clientActive: true,
      },
      {
        rows: [
          { id: "a", label: "R1" },
          { id: "b", label: "R2" },
        ],
        serverActive: true,
        clientActive: true,
      },
    ].flatMap((values) =>
      [
        `<main><for each={rows} key={row.id}><p>{row.label}</p></for><if test={active}><button>{label}</button></if><footer>{tail}</footer></main>`,
        `<main><if test={active}><button>{label}</button></if><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`,
      ].map((source) => ({ source, ...values })),
    ),
  )(
    "hydrates SSR for and if siblings under one parent through their region markers",
    ({ source, rows, serverActive, clientActive }) => {
      const compiled = compileTemplate(source);
      if (!compiled.ok) throw new Error(compiled.error.message);
      expect(compiled.value.client.hydrationDynamicRegionErrors).toEqual([]);
      const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
      const root = document.createElement("div");
      root.innerHTML = renderServerTemplate(compiled.value, {
        rows,
        active: serverActive,
        label: "A",
        tail: "F",
      });
      const serverRows = Array.from(root.querySelectorAll("p"));
      const serverFooter = root.querySelector("footer");
      const rowsSignal = createSignal(rows);
      const active = createSignal(clientActive);
      const label = createSignal("A");
      const tail = createSignal("F");
      const result = hydrate(root, module, { rows: rowsSignal, active, label, tail });

      if (!result.ok) throw new Error(result.error.message);
      expect(Array.from(root.querySelectorAll("p"))).toEqual(serverRows);
      expect(root.querySelector("footer")).toBe(serverFooter);
      expect(root.querySelector("button")?.textContent ?? null).toBe(clientActive ? "A" : null);
      rowsSignal.set([...rows, { id: "z", label: "R9" }]);
      active.set(!clientActive);
      label.set("B");
      tail.set("G");
      expect(Array.from(root.querySelectorAll("p")).map((row) => row.textContent)).toEqual([
        ...rows.map((row) => row.label),
        "R9",
      ]);
      expect(root.querySelector("button")?.textContent ?? null).toBe(clientActive ? null : "B");
      expect(root.querySelector("footer")?.textContent).toBe("G");
      const order = Array.from(root.querySelector("main")?.children ?? []).map((child) => child.tagName);
      const rowTags = [...rows, { id: "z" }].map(() => "P");
      const buttonTags = clientActive ? [] : ["BUTTON"];
      expect(order).toEqual(
        source.indexOf("<for") < source.indexOf("<if")
          ? [...rowTags, ...buttonTags, "FOOTER"]
          : [...buttonTags, ...rowTags, "FOOTER"],
      );
      result.value.dispose();
    },
  );

  it.each([
    { order: "for-if", groups: [], active: false },
    { order: "for-if", groups: [{ id: "g1", rows: [] }], active: true },
    {
      order: "for-if",
      groups: [
        { id: "g1", rows: [{ id: "r1", label: "R1" }] },
        { id: "g2", rows: [{ id: "r2", label: "R2" }] },
      ],
      active: false,
    },
    { order: "if-for", groups: [], active: true },
    { order: "if-for", groups: [{ id: "g1", rows: [] }], active: false },
    {
      order: "if-for",
      groups: [
        { id: "g1", rows: [{ id: "r1", label: "R1" }] },
        { id: "g2", rows: [{ id: "r2", label: "R2" }] },
      ],
      active: true,
    },
  ] as const)("hydrates dynamic regions shared inside every generated list row", ({ order, groups, active }) => {
    const dynamicSource =
      order === "for-if"
        ? `<for each={group.rows} key={row.id}><p>{row.label}</p></for><if test={active}><button on:click={save}>{label}</button></if>`
        : `<if test={active}><button on:click={save}>{label}</button></if><for each={group.rows} key={row.id}><p>{row.label}</p></for>`;
    const source = `<main><for each={groups} key={group.id}><section>${dynamicSource}<footer>{tail}</footer></section></for></main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      groups,
      active,
      label: "SSR button",
      tail: "SSR footer",
      save: () => undefined,
    });
    const serverButtons = Array.from(root.querySelectorAll("button"));
    const serverFooters = Array.from(root.querySelectorAll("footer"));
    const serverRows = Array.from(root.querySelectorAll("p"));
    const activeSignal = createSignal(active);
    const tail = createSignal("Client footer");
    const result = hydrate(root, module, {
      groups: createSignal(groups),
      active: activeSignal,
      label: createSignal("Client button"),
      tail,
      save: () => undefined,
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(Array.from(root.querySelectorAll("button"))).toEqual(serverButtons);
    expect(Array.from(root.querySelectorAll("footer"))).toEqual(serverFooters);
    expect(Array.from(root.querySelectorAll("p"))).toEqual(serverRows);
    expect(Array.from(root.querySelectorAll("footer")).map((footer) => footer.textContent)).toEqual(
      groups.map(() => "Client footer"),
    );
    tail.set("Client footer 2");
    activeSignal.set(!active);
    expect(root.querySelectorAll("button")).toHaveLength(active ? 0 : groups.length);
    expect(Array.from(root.querySelectorAll("footer")).map((footer) => footer.textContent)).toEqual(
      groups.map(() => "Client footer 2"),
    );
    expect(Array.from(root.querySelectorAll("p")).map((row) => row.textContent)).toEqual(
      groups.flatMap((group) => group.rows.map((row) => row.label)),
    );
    result.value.dispose();
  });

  it("hydrates dynamic regions split by a transparent component", () => {
    const compiled = compileTemplate(
      `<main><component name="Region"><for each={rows} key={row.id}><p>{row.label}</p></for></component><if test={active}><button>{label}</button></if><footer>{tail}</footer></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(compiled.value.client.hydrationDynamicRegionErrors).toHaveLength(0);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const rows = [
      { id: "r1", label: "R1" },
      { id: "r2", label: "R2" },
    ];
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      rows,
      active: true,
      label: "SSR button",
      tail: "SSR footer",
    });
    const serverRow = root.querySelector("p");
    const serverButton = root.querySelector("button");
    const serverFooter = root.querySelector("footer");
    const rowsSignal = createSignal(rows);
    const active = createSignal(true);
    const result = hydrate(root, module, {
      rows: rowsSignal,
      active,
      label: createSignal("Client button"),
      tail: createSignal("Client footer"),
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(root.querySelector("p")).toBe(serverRow);
    expect(root.querySelector("button")).toBe(serverButton);
    expect(root.querySelector("footer")).toBe(serverFooter);
    expect(root.querySelector("button")?.textContent).toBe("Client button");
    rowsSignal.set([{ id: "r2", label: "R2" }]);
    active.set(false);
    expect(Array.from(root.querySelectorAll("p")).map((row) => row.textContent)).toEqual(["R2"]);
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("footer")?.textContent).toBe("Client footer");
    result.value.dispose();
  });

  it("hydrates dynamic regions under separate parents", () => {
    const compiled = compileTemplate(
      `<main><section><for each={rows} key={row.id}><p>{row.label}</p></for></section><aside><if test={active}><button>{label}</button></if></aside></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      rows: [{ id: "r1", label: "R1" }],
      active: true,
      label: "SSR",
    });
    const serverRow = root.querySelector("p");
    const serverButton = root.querySelector("button");
    const result = hydrate(root, module, {
      rows: createSignal([{ id: "r1", label: "Client row" }]),
      active: createSignal(true),
      label: createSignal("Client button"),
    });

    expect(result.ok).toBe(true);
    expect(root.querySelector("p")).toBe(serverRow);
    expect(root.querySelector("button")).toBe(serverButton);
    expect(root.textContent).toBe("Client rowClient button");
    if (result.ok) result.value.dispose();
  });

  it("keeps bindings after a generated conditional on their original nodes", () => {
    const compiled = compileTemplate(`<main><if test={visible}><p>{left}</p></if><footer>{tail}</footer></main>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const visible = createSignal(true);
    const left = createSignal("A");
    const tail = createSignal("Footer");
    const root = document.createElement("div");
    const handle = mount(root, module, { visible, left, tail });
    const paragraph = root.querySelector("p");
    const footer = root.querySelector("footer");

    expect(paragraph?.textContent).toBe("A");
    expect(footer?.textContent).toBe("Footer");
    tail.set("Footer2");
    expect(paragraph?.textContent).toBe("A");
    expect(footer?.textContent).toBe("Footer2");
    visible.set(false);
    expect(root.querySelector("p")).toBeNull();
    expect(root.querySelector("footer")).toBe(footer);
    tail.set("Footer3");
    expect(footer?.textContent).toBe("Footer3");
    handle.dispose();

    const ssrRoot = document.createElement("div");
    ssrRoot.innerHTML = renderServerTemplate(compiled.value, { visible: true, left: "SSR", tail: "Footer" });
    const serverParagraph = ssrRoot.querySelector("p");
    const serverFooter = ssrRoot.querySelector("footer");
    const hydratedVisible = createSignal(true);
    const hydratedLeft = createSignal("Hydrated");
    const hydratedTail = createSignal("Hydrated footer");
    const hydrated = hydrate(ssrRoot, module, {
      visible: hydratedVisible,
      left: hydratedLeft,
      tail: hydratedTail,
    });
    if (!hydrated.ok) throw new Error(hydrated.error.message);

    expect(ssrRoot.querySelector("p")).toBe(serverParagraph);
    expect(ssrRoot.querySelector("footer")).toBe(serverFooter);
    expect(serverParagraph?.textContent).toBe("Hydrated");
    expect(serverFooter?.textContent).toBe("Hydrated footer");
    hydratedTail.set("Hydrated footer 2");
    expect(serverParagraph?.textContent).toBe("Hydrated");
    expect(serverFooter?.textContent).toBe("Hydrated footer 2");
    hydrated.value.dispose();
  });

  it("keeps events after a generated conditional on their original element", () => {
    const compiled = compileTemplate(
      `<main><if test={visible}><p>Branch</p></if><button on:click={save}>{label}</button></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const visible = createSignal(true);
    const label = createSignal("Button");
    let clicks = 0;
    const root = document.createElement("div");
    const handle = mount(root, module, { visible, label, save: () => clicks++ });
    const button = root.querySelector("button");

    button?.click();
    expect(clicks).toBe(1);
    visible.set(false);
    label.set("Updated");
    expect(root.querySelector("button")).toBe(button);
    expect(button?.textContent).toBe("Updated");
    button?.click();
    expect(clicks).toBe(2);
    handle.dispose();
    button?.click();
    expect(clicks).toBe(2);
  });

  it("maps SSR parents after an earlier conditional expands to multiple roots", () => {
    const compiled = compileTemplate(
      `<main><if test={firstVisible}><p>{left}</p><p>Extra</p></if><section><if test={secondVisible}><button>{right}</button></if></section></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      firstVisible: true,
      secondVisible: true,
      left: "L",
      right: "R",
    });
    const serverButton = root.querySelector("section button");
    const firstVisible = createSignal(true);
    const secondVisible = createSignal(true);
    const right = createSignal("Hydrated");
    const result = hydrate(root, module, { firstVisible, secondVisible, left: "L", right });
    if (!result.ok) throw new Error(result.error.message);

    expect(root.querySelectorAll("button")).toHaveLength(1);
    expect(root.querySelector("section button")).toBe(serverButton);
    right.set("Updated");
    expect(serverButton?.textContent).toBe("Updated");
    expect(root.querySelector("p button")).toBeNull();
    result.value.dispose();
  });

  it("keeps bindings after a generic conditional follows a lightweight conditional", () => {
    const compiled = compileTemplate(
      `<main><if test={core}><p>{left}</p></if><if test={generic}><form><input bind:value={value}></form></if><footer>{tail}</footer></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const core = createSignal(true);
    const generic = createSignal(true);
    const left = createSignal("A");
    const tail = createSignal("Footer");
    const root = document.createElement("div");
    const handle = mount(root, module, { core, generic, left, tail, value: "Input" });
    const footer = root.querySelector("footer");

    expect(root.querySelector("form")).not.toBeNull();
    expect(footer?.textContent).toBe("Footer");
    tail.set("Footer2");
    expect(footer?.textContent).toBe("Footer2");
    generic.set(false);
    expect(root.querySelector("form")).toBeNull();
    tail.set("Footer3");
    expect(footer?.textContent).toBe("Footer3");
    generic.set(true);
    expect(root.querySelector("form")).not.toBeNull();
    handle.dispose();

    const ssrRoot = document.createElement("div");
    ssrRoot.innerHTML = renderServerTemplate(compiled.value, {
      core: true,
      generic: true,
      left: "SSR",
      tail: "SSR footer",
      value: "SSR input",
    });
    const serverForm = ssrRoot.querySelector("form");
    const serverFooter = ssrRoot.querySelector("footer");
    const hydrated = hydrate(ssrRoot, module, {
      core: createSignal(true),
      generic: createSignal(true),
      left: createSignal("Hydrated"),
      tail: createSignal("Hydrated footer"),
      value: "Hydrated input",
    });
    if (!hydrated.ok) throw new Error(hydrated.error.message);

    expect(ssrRoot.querySelector("form")).toBe(serverForm);
    expect(ssrRoot.querySelector("footer")).toBe(serverFooter);
    expect(serverFooter?.textContent).toBe("Hydrated footer");
    hydrated.value.dispose();
  });

  it("evaluates a generated conditional expression once during initial binding", () => {
    const compiled = compileTemplate(`<main><if test={check()}><p>A</p></if></main>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));

    let mountChecks = 0;
    const mounted = document.createElement("div");
    const mountHandle = mount(mounted, module, { check: () => (mountChecks++, true) });
    expect(mountChecks).toBe(1);
    mountHandle.dispose();

    let serverChecks = 0;
    const ssrRoot = document.createElement("div");
    ssrRoot.innerHTML = renderServerTemplate(compiled.value, {
      check: () => (serverChecks++, true),
    });
    let hydrateChecks = 0;
    const hydrated = hydrate(ssrRoot, module, { check: () => (hydrateChecks++, true) });
    if (!hydrated.ok) throw new Error(hydrated.error.message);
    expect(serverChecks).toBe(1);
    expect(hydrateChecks).toBe(1);
    hydrated.value.dispose();
  });

  it.each(["", null, undefined])("materializes generated conditional SSR text markers for %j", (initialValue) => {
    const compiled = compileTemplate(`<main><if test={visible}><p>{label}<span>{other}</span></p></if></main>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      visible: true,
      label: initialValue,
      other: initialValue,
    });
    const firstParagraph = root.querySelector("p");
    if (!(firstParagraph instanceof HTMLParagraphElement)) throw new Error("Missing SSR paragraph.");
    const visible = createSignal(true);
    const label = createSignal<string | null | undefined>(initialValue);
    const other = createSignal<string | null | undefined>(initialValue);
    const hydrated = hydrate(root, module, { visible, label, other });
    if (!hydrated.ok) throw new Error(hydrated.error.message);

    expect(root.querySelector("p")).toBe(firstParagraph);
    expect(firstParagraph.textContent).toBe("");
    label.set("ready");
    expect(firstParagraph.textContent).toBe("ready");
    expect(firstParagraph.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    label.set("");
    other.set("second");
    expect(firstParagraph.textContent).toBe("second");
    visible.set(false);
    expect(root.querySelector("p")).toBeNull();
    visible.set(true);
    expect(root.querySelector("p")?.textContent).toBe("second");

    hydrated.value.dispose();
  });

  it("emits the generated text-list entry while preserving its runtime behavior", () => {
    const compiled = compileTemplate(`<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value, { reactive: true });
    expect(generated).toContain(`mountGeneratedTextKeyedList as __tachyonMountTextKeyedList`);
    const module = evaluateGeneratedClientModule(generated);
    const root = document.createElement("div");
    const rows = createSignal([{ id: "a", label: "A" }]);

    mount(root, module, { rows });
    const firstRow = root.querySelector("li");
    rows.set([
      { id: "a", label: "B" },
      { id: "b", label: "C" },
    ]);

    expect(root.textContent).toBe("BC");
    expect(root.querySelector("li")).toBe(firstRow);
  });

  it.each([
    [
      "text",
      `<main><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`,
      `mountGeneratedTextKeyedList as __tachyonMountTextKeyedList`,
    ],
    [
      "mixed",
      `<main><for each={rows} key={row.id}><p class:active={row.active}>{row.label}</p></for><footer>{tail}</footer></main>`,
      `mountGeneratedTextKeyedList as __tachyonMountTextKeyedList`,
    ],
    [
      "generic",
      `<main><for each={rows} key={row.id}><p style:opacity={row.opacity}>{row.label}</p></for><footer>{tail}</footer></main>`,
      `mountGeneratedKeyedList as __tachyonMountGeneratedKeyedList`,
    ],
  ])("keeps the generated %s list footer binding after rows move", (name, source, generatedImport) => {
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value, { reactive: true });
    expect(generated).toContain(generatedImport);
    const module = evaluateGeneratedClientModule(generated);
    const first = { id: "a", label: "A", active: true };
    const second = { id: "b", label: "B", active: false };
    const third = { id: "c", label: "C", active: true };
    const rows = createSignal([first, second]);
    const tail = createSignal("F");
    const root = document.createElement("div");
    const handle = mount(root, module, { rows, tail });
    const footer = root.querySelector("footer");
    const firstRow = root.querySelectorAll("p")[0];

    expect(root.querySelector("main")?.textContent).toBe("ABF");
    expect(footer?.textContent).toBe("F");
    tail.set("F2");
    expect(footer?.textContent).toBe("F2");
    expect(firstRow?.textContent).toBe("A");

    rows.set([second, third, first]);
    expect(root.querySelector("main")?.textContent).toBe("BCAF2");
    expect(root.querySelector("footer")).toBe(footer);
    expect(root.querySelectorAll("p")[2]).toBe(firstRow);

    rows.set([third]);
    expect(root.querySelector("main")?.textContent).toBe("CF2");
    expect(root.querySelector("footer")).toBe(footer);
    handle.dispose();

    const hydratedRoot = document.createElement("div");
    hydratedRoot.innerHTML = renderServerTemplate(compiled.value, {
      rows: [first, second],
      tail: "SSR footer",
    });
    const serverFooter = hydratedRoot.querySelector("footer");
    const hydratedRows = createSignal([first, second]);
    const hydratedTail = createSignal("Hydrated footer");
    const hydrated = hydrate(hydratedRoot, module, { rows: hydratedRows, tail: hydratedTail });
    if (!hydrated.ok) throw new Error(hydrated.error.message);

    expect(hydratedRoot.querySelector("footer")).toBe(serverFooter);
    expect(hydratedRoot.querySelector("main")?.textContent).toBe("ABHydrated footer");
    hydratedTail.set("Hydrated footer 2");
    expect(serverFooter?.textContent).toBe("Hydrated footer 2");
    hydratedRows.set([second, third, first]);
    expect(hydratedRoot.querySelector("main")?.textContent).toBe("BCAHydrated footer 2");
    expect(hydratedRoot.querySelector("footer")).toBe(serverFooter);
    hydrated.value.dispose();
  });

  it.each([0, 1, 2] as const)("keeps a generated list header binding before %i rows", (count) => {
    const compiled = compileTemplate(
      `<main><header>{head}</header><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const initialRows = Array.from({ length: count }, (_, id) => ({ id: String(id), label: `R${id}` }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      head: "H",
      rows: initialRows,
      tail: "F",
    });
    const header = root.querySelector("header");
    const footer = root.querySelector("footer");
    const head = createSignal("H");
    const tail = createSignal("F");
    const rows = createSignal(initialRows);
    const result = hydrate(root, module, { head, tail, rows });
    if (!result.ok) throw new Error(result.error.message);

    expect(root.querySelector("header")).toBe(header);
    expect(root.querySelector("footer")).toBe(footer);
    expect(header?.textContent).toBe("H");
    expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(
      initialRows.map((row) => row.label),
    );

    head.set("H2");
    tail.set("F2");
    expect(header?.textContent).toBe("H2");
    expect(footer?.textContent).toBe("F2");
    expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(
      initialRows.map((row) => row.label),
    );

    const reorderedRows = [...initialRows].reverse().concat({ id: "new", label: "Rnew" });
    rows.set(reorderedRows);
    expect(header?.textContent).toBe("H2");
    expect(footer?.textContent).toBe("F2");
    expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(
      reorderedRows.map((row) => row.label),
    );
    expect(root.querySelector("header")).toBe(header);
    expect(root.querySelector("footer")).toBe(footer);
    result.value.dispose();
  });

  it.each([false, true] as const)("keeps a generated list header binding after a static text prefix (%s)", (withIf) => {
    const inner = `intro<header>{head}</header><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer>`;
    const source = withIf
      ? `<main><section>${inner}</section><aside><if test={visible}><b>branch</b></if></aside></main>`
      : `<main>${inner}</main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    for (const count of [0, 1, 2] as const) {
      const initialRows = Array.from({ length: count }, (_, id) => ({ id: String(id), label: `R${id}` }));
      const root = document.createElement("div");
      root.innerHTML = renderServerTemplate(compiled.value, {
        head: "H",
        rows: initialRows,
        tail: "F",
        visible: true,
      });
      const header = root.querySelector("header");
      const footer = root.querySelector("footer");
      const head = createSignal("H");
      const tail = createSignal("F");
      const rows = createSignal(initialRows);
      const visible = createSignal(true);
      const result = hydrate(root, module, { head, tail, rows, visible });
      if (!result.ok) throw new Error(result.error.message);

      head.set("H2");
      tail.set("F2");
      expect(root.querySelector("header")).toBe(header);
      expect(header?.textContent).toBe("H2");
      expect(root.querySelector("footer")).toBe(footer);
      expect(footer?.textContent).toBe("F2");
      expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(
        initialRows.map((row) => row.label),
      );

      const reorderedRows = [...initialRows].reverse().concat({ id: "new", label: "Rnew" });
      rows.set(reorderedRows);
      expect(root.querySelector("header")).toBe(header);
      expect(root.querySelector("footer")).toBe(footer);
      expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(
        reorderedRows.map((row) => row.label),
      );
      result.value.dispose();
    }
  });

  it("keeps list paths aligned across multiple static text nodes and SSR hydration markers", () => {
    const source = `<main>intro<span>gap</span>tail<header hydrate>{head}</header><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const first = { id: "a", label: "A" };
    const second = { id: "b", label: "B" };
    const third = { id: "c", label: "C" };
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      head: "H",
      rows: [first, second],
      tail: "F",
    });
    const header = root.querySelector("header");
    const footer = root.querySelector("footer");
    const head = createSignal("H");
    const tail = createSignal("F");
    const rows = createSignal([first, second]);
    const result = hydrate(root, module, { head, tail, rows });
    if (!result.ok) throw new Error(result.error.message);

    head.set("H2");
    tail.set("F2");
    expect(root.querySelector("header")).toBe(header);
    expect(header?.textContent).toBe("H2");
    expect(root.querySelector("footer")).toBe(footer);
    expect(footer?.textContent).toBe("F2");
    expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(["A", "B"]);

    rows.set([third, second, first]);
    expect(root.querySelector("header")).toBe(header);
    expect(root.querySelector("footer")).toBe(footer);
    expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(["C", "B", "A"]);
    rows.set([second]);
    expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(["B"]);
    result.value.dispose();
    expect(root.querySelectorAll("p")).toHaveLength(0);
  });

  it.each([
    ["static-prefix", `<main>intro<for each={rows} key={row.id}><p>{row.label}</p></for></main>`, "intro", ""],
    ["static-suffix", `<main><for each={rows} key={row.id}><p>{row.label}</p></for>tail</main>`, "", "tail"],
    ["static-both", `<main>intro<for each={rows} key={row.id}><p>{row.label}</p></for>tail</main>`, "intro", "tail"],
    ["dynamic-prefix", `<main>{head}<for each={rows} key={row.id}><p>{row.label}</p></for>tail</main>`, "H", "tail"],
    ["dynamic-suffix", `<main>intro<for each={rows} key={row.id}><p>{row.label}</p></for>{tail}</main>`, "intro", "F"],
    ["dynamic-both", `<main>{head}<for each={rows} key={row.id}><p>{row.label}</p></for>{tail}</main>`, "H", "F"],
  ] as const)(
    "keeps Text-only list siblings and bindings aligned for %s",
    (_name, source, initialPrefix, initialSuffix) => {
      const compiled = compileTemplate(source);
      if (!compiled.ok) throw new Error(compiled.error.message);
      const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));

      for (const count of [0, 1, 2]) {
        for (const mode of ["mount", "hydrate"] as const) {
          const initialRows = Array.from({ length: count }, (_, id) => ({ id: String(id), label: `R${id}` }));
          const root = document.createElement("div");
          const head = createSignal("H");
          const tail = createSignal("F");
          const rows = createSignal(initialRows);
          if (mode === "hydrate") {
            root.innerHTML = renderServerTemplate(compiled.value, {
              head: "H",
              tail: "F",
              rows: initialRows,
            });
          }
          const handle =
            mode === "mount"
              ? mount(root, module, { head, tail, rows })
              : (() => {
                  const result = hydrate(root, module, { head, tail, rows });
                  if (!result.ok) throw new Error(result.error.message);
                  return result.value;
                })();
          const main = root.querySelector("main");
          if (!(main instanceof HTMLElement)) throw new Error("Missing Text-only list root.");
          const preservedTextNodes = Array.from(main.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
          const expectedInitialPrefix = initialPrefix === "H" ? "H" : initialPrefix;
          const expectedInitialSuffix = initialSuffix === "F" ? "F" : initialSuffix;
          const expectedText = (prefix: string, suffix: string, values: readonly { label: string }[]) =>
            `${prefix}${values.map((row) => row.label).join("")}${suffix}`;

          expect(main.textContent).toBe(expectedText(expectedInitialPrefix, expectedInitialSuffix, initialRows));
          head.set("H2");
          tail.set("F2");
          const updatedPrefix = initialPrefix === "H" ? "H2" : initialPrefix;
          const updatedSuffix = initialSuffix === "F" ? "F2" : initialSuffix;
          expect(main.textContent).toBe(expectedText(updatedPrefix, updatedSuffix, initialRows));
          expect(preservedTextNodes.every((node) => main.contains(node))).toBe(true);

          const initialFirstRow = main.querySelector("p");
          const updatedRows = [
            { id: "0", label: "U0" },
            { id: "1", label: "U1" },
          ];
          rows.set(updatedRows);
          expect(main.textContent).toBe(expectedText(updatedPrefix, updatedSuffix, updatedRows));
          if (count > 0) expect(main.querySelector("p")).toBe(initialFirstRow);
          const updatedElements = Array.from(main.querySelectorAll("p"));

          const reorderedRows = [...updatedRows].reverse();
          rows.set(reorderedRows);
          expect(Array.from(main.querySelectorAll("p"))).toEqual([updatedElements[1], updatedElements[0]]);
          const appendedRows = [...reorderedRows, { id: "2", label: "A2" }];
          rows.set(appendedRows);
          expect(main.textContent).toBe(expectedText(updatedPrefix, updatedSuffix, appendedRows));
          const appendedElements = Array.from(main.querySelectorAll("p"));
          const removedRow = appendedRows[1];
          if (!removedRow) throw new Error("Missing retained row for removal.");
          const removedRows = [removedRow];
          rows.set(removedRows);
          expect(main.textContent).toBe(expectedText(updatedPrefix, updatedSuffix, removedRows));
          expect(appendedElements[0]?.isConnected).toBe(false);
          expect(preservedTextNodes.every((node) => main.contains(node))).toBe(true);

          handle.dispose();
          const disposedText = main.textContent;
          expect(disposedText).toBe(expectedText(updatedPrefix, updatedSuffix, []));
          head.set("H3");
          tail.set("F3");
          rows.set([]);
          expect(main.textContent).toBe(disposedText);
          expect(preservedTextNodes.every((node) => main.contains(node))).toBe(true);
        }
      }
    },
  );

  it("keeps list paths aligned after a transparent component with text nodes", () => {
    const source = `<main><component name="Prefix">intro{prefix}</component><header>{head}</header><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const first = { id: "a", label: "A" };
    const second = { id: "b", label: "B" };
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      prefix: "P",
      head: "H",
      rows: [first, second],
      tail: "F",
    });
    const header = root.querySelector("header");
    const footer = root.querySelector("footer");
    const prefix = createSignal("P");
    const head = createSignal("H");
    const tail = createSignal("F");
    const rows = createSignal([first, second]);
    const result = hydrate(root, module, { prefix, head, tail, rows });
    if (!result.ok) throw new Error(result.error.message);

    prefix.set("P2");
    head.set("H2");
    tail.set("F2");
    expect(root.querySelector("header")).toBe(header);
    expect(header?.textContent).toBe("H2");
    expect(root.querySelector("footer")).toBe(footer);
    expect(footer?.textContent).toBe("F2");
    expect(root.textContent).toBe("introP2H2ABF2");
    expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(["A", "B"]);
    result.value.dispose();
  });

  it.each(["mount", "hydrate"] as const)("keeps a list root inside a transparent component aligned in %s", (mode) => {
    const source = `<main><header>{head}</header><component name="Rows"><for each={rows} key={row.id}><p>{row.label}</p></for></component><footer>{tail}</footer></main>`;
    const compiled = compileTemplate(source);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const first = { id: "a", label: "A" };
    const second = { id: "b", label: "B" };
    const third = { id: "c", label: "C" };
    const head = createSignal("H");
    const tail = createSignal("F");
    const rows = createSignal([first, second]);
    const root = document.createElement("div");
    if (mode === "hydrate") {
      root.innerHTML = renderServerTemplate(compiled.value, { head: "H", tail: "F", rows: [first, second] });
    }
    const result =
      mode === "mount"
        ? { ok: true as const, value: mount(root, module, { head, tail, rows }) }
        : hydrate(root, module, { head, tail, rows });
    if (!result.ok) throw new Error(result.error.message);
    const header = root.querySelector("header");
    const footer = root.querySelector("footer");
    const initialRows = Array.from(root.querySelectorAll("p"));

    expect(root.textContent).toBe("HABF");
    head.set("H2");
    tail.set("F2");
    expect(root.textContent).toBe("H2ABF2");
    expect(root.querySelector("header")).toBe(header);
    expect(root.querySelector("footer")).toBe(footer);
    expect(Array.from(root.querySelectorAll("p"))).toEqual(initialRows);

    rows.set([second, third, first]);
    const reorderedRows = Array.from(root.querySelectorAll("p"));
    expect(root.textContent).toBe("H2BCAF2");
    expect(reorderedRows[0]).toBe(initialRows[1]);
    expect(reorderedRows[2]).toBe(initialRows[0]);

    rows.set([third]);
    expect(root.textContent).toBe("H2CF2");
    expect(root.querySelector("header")).toBe(header);
    expect(root.querySelector("footer")).toBe(footer);
    expect(reorderedRows[0]?.isConnected).toBe(false);

    result.value.dispose();
    expect(root.textContent).toBe("H2F2");
    tail.set("ignored");
    rows.set([]);
    expect(root.textContent).toBe("H2F2");
  });

  it.each(["mount", "hydrate"] as const)(
    "composes generated list binding paths with an unrelated conditional in %s",
    (mode) => {
      const compiled = compileTemplate(
        `<main><section><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></section><aside><if test={visible}><b>{head}</b></if></aside></main>`,
      );
      if (!compiled.ok) throw new Error(compiled.error.message);
      const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
      const first = { id: "a", label: "A" };
      const second = { id: "b", label: "B" };
      const third = { id: "c", label: "C" };
      const rows = createSignal([first, second]);
      const tail = createSignal("F");
      const head = createSignal("H");
      const visible = createSignal(true);
      const root = document.createElement("div");
      if (mode === "hydrate") {
        root.innerHTML = renderServerTemplate(compiled.value, {
          rows: [first, second],
          tail: "SSR footer",
          head: "SSR heading",
          visible: true,
        });
      }
      const result =
        mode === "mount"
          ? { ok: true as const, value: mount(root, module, { rows, tail, head, visible }) }
          : hydrate(root, module, { rows, tail, head, visible });
      if (!result.ok) throw new Error(result.error.message);
      const footer = root.querySelector("footer");

      expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(["A", "B"]);
      expect(footer?.textContent).toBe("F");
      tail.set("F2");
      expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(["A", "B"]);
      expect(footer?.textContent).toBe("F2");

      rows.set([second, third, first]);
      expect(Array.from(root.querySelectorAll("p"), (row) => row.textContent)).toEqual(["B", "C", "A"]);
      expect(root.querySelector("footer")).toBe(footer);
      expect(footer?.textContent).toBe("F2");
      result.value.dispose();
      tail.set("ignored");
      expect(footer?.textContent).toBe("F2");
    },
  );

  it("reconciles generated text rows with indexes, outer signals, and nested signals", () => {
    const compiled = compileTemplate(
      `<ul><for each={rows} as="row" index="position" key={row.id}><li>{prefix()}:{position}:{row.label()}</li></for></ul>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value, { reactive: true });
    expect(generated).toContain(`mountGeneratedTextKeyedList as __tachyonMountTextKeyedList`);
    const module = evaluateGeneratedClientModule(generated);
    const root = document.createElement("div");
    const prefix = createSignal("P");
    type GeneratedRow = { id: string; label: ReturnType<typeof createSignal<string>> };
    const rows = createSignal<GeneratedRow[]>([
      { id: "a", label: createSignal("A") },
      { id: "b", label: createSignal("B") },
      { id: "c", label: createSignal("C") },
    ]);

    mount(root, module, { prefix, rows });
    const firstRow = root.querySelectorAll("li")[0];
    const thirdRow = root.querySelectorAll("li")[2];
    expect(root.textContent).toBe("P:0:AP:1:BP:2:C");

    rows()[0]?.label.set("A2");
    prefix.set("Q");
    expect(root.textContent).toBe("Q:0:A2Q:1:BQ:2:C");

    const currentRows = rows();
    const currentThird = currentRows[2];
    const currentFirst = currentRows[0];
    if (!currentThird || !currentFirst) throw new Error("Missing generated list rows.");
    rows.set([currentThird, { id: "d", label: createSignal("D") }, currentFirst]);

    expect(root.textContent).toBe("Q:0:CQ:1:DQ:2:A2");
    expect(root.querySelectorAll("li")[0]).toBe(thirdRow);
    expect(root.querySelectorAll("li")[2]).toBe(firstRow);
    expect(root.querySelectorAll("li")[1]?.textContent).toBe("Q:1:D");
    expect(root.querySelectorAll("li").length).toBe(3);
  });

  it("hydrates generated multi-root text rows, preserves static siblings, and disposes updates", () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li>{row.label}</li><hr></for><footer>Footer</footer></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const first = { id: "a", label: "A" };
    const second = { id: "b", label: "B" };
    const rows = createSignal([first, second]);
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, { rows: [first, second] });
    const serverRows = Array.from(root.querySelectorAll("li"));
    const footer = root.querySelector("footer");

    const hydrated = hydrate(root, module, { rows });
    if (!hydrated.ok) throw new Error(hydrated.error.message);
    expect(root.textContent).toBe("ABFooter");
    expect(Array.from(root.querySelectorAll("li"))).toEqual(serverRows);
    expect(root.querySelector("footer")).toBe(footer);

    const third = { id: "c", label: "C" };
    rows.set([second, third, first]);
    const reorderedRows = Array.from(root.querySelectorAll("li"));
    expect(root.textContent).toBe("BCAFooter");
    expect(reorderedRows[0]).toBe(serverRows[1]);
    expect(reorderedRows[2]).toBe(serverRows[0]);
    expect(root.querySelector("footer")).toBe(footer);

    rows.set([first]);
    expect(root.textContent).toBe("AFooter");
    const remainingRow = root.querySelector("li");
    hydrated.value.dispose();
    expect(root.querySelector("li")).toBeNull();
    rows.set([second]);
    expect(root.querySelector("li")).toBeNull();
    expect(remainingRow?.isConnected).toBe(false);
  });

  it("isolates generated text-list roots and releases generated reader cleanups", () => {
    let cleanupCount = 0;
    let subscriptionCount = 0;
    const restoreHooks = setRuntimeLifecycleHooks({
      cleanupChanged: (delta) => {
        cleanupCount += delta;
      },
      subscriptionChanged: (delta) => {
        subscriptionCount += delta;
      },
    });
    const handles: Array<ReturnType<typeof mount>> = [];
    try {
      const compiled = compileTemplate(`<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`);
      if (!compiled.ok) throw new Error(compiled.error.message);
      const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
      const firstRows = createSignal([{ id: "a", label: "A" }]);
      const secondRows = createSignal([{ id: "b", label: "B" }]);
      const firstRoot = document.createElement("div");
      const secondRoot = document.createElement("div");
      handles.push(mount(firstRoot, module, { rows: firstRows }));
      handles.push(mount(secondRoot, module, { rows: secondRows }));
      const secondRow = secondRoot.querySelector("li");

      firstRows.set([{ id: "a", label: "A1" }]);
      expect(firstRoot.textContent).toBe("A1");
      expect(secondRoot.textContent).toBe("B");
      handles[0]?.dispose();
      firstRows.set([{ id: "a", label: "ignored" }]);
      expect(firstRoot.textContent).toBe("");
      secondRows.set([{ id: "b", label: "B1" }]);
      expect(secondRoot.textContent).toBe("B1");
      expect(secondRoot.querySelector("li")).toBe(secondRow);

      const throwingCompiled = compileTemplate(
        `<ul><for each={rows} key={row.id}><li>{register(row.id)}</li></for></ul>`,
      );
      if (!throwingCompiled.ok) throw new Error(throwingCompiled.error.message);
      const throwingModule = evaluateGeneratedClientModule(
        generateClientModule(throwingCompiled.value, { reactive: true }),
      );
      const cleaned: number[] = [];
      const throwingRows = createSignal([{ id: 1 }, { id: 2 }]);
      const throwingRoot = document.createElement("div");
      const throwingHandle = mount(throwingRoot, throwingModule, {
        rows: throwingRows,
        register: (id: number) => {
          onCleanup(() => {
            cleaned.push(id);
            if (id === 1) throw new Error("generated reader cleanup failed");
          });
          return String(id);
        },
      });
      expect(() => throwingRows.set([])).toThrow("generated reader cleanup failed");
      expect(cleaned.sort()).toEqual([1, 2]);
      expect(throwingRoot.textContent).toBe("");
      expect(() => throwingRows.set([])).not.toThrow();

      const rootDisposeRows = createSignal([{ id: 1 }]);
      const rootDisposeRoot = document.createElement("div");
      const rootDisposeHandle = mount(rootDisposeRoot, throwingModule, {
        rows: rootDisposeRows,
        register: (id: number) => {
          onCleanup(() => {
            if (id === 1) throw new Error("generated root cleanup failed");
          });
          return String(id);
        },
      });
      expect(() => rootDisposeHandle.dispose()).toThrow("generated root cleanup failed");
      expect(rootDisposeRoot.textContent).toBe("");
      expect(() => rootDisposeHandle.dispose()).not.toThrow();
      throwingHandle.dispose();
      handles[1]?.dispose();
    } finally {
      for (const handle of handles) handle.dispose();
      restoreHooks();
    }
    expect(cleanupCount).toBe(0);
    expect(subscriptionCount).toBe(0);
  });

  it("uses the generated keyRead adapter for composite keys and changes row keys safely", () => {
    const compiled = compileTemplate(`<ul><for each={rows} key={row.id + suffix}><li>{row.label}</li></for></ul>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value, { reactive: true });
    expect(generated).toContain(`keyRead: (scope) =>`);
    expect(generated).not.toContain(`keyReadItem:`);
    const module = evaluateGeneratedClientModule(generated);
    const root = document.createElement("div");
    const first = { id: "a", label: "A" };
    const second = { id: "b", label: "B" };
    const rows = createSignal([first, second]);
    const scope = { rows, suffix: "-one" };
    const handle = mount(root, module, scope);
    const firstRow = root.querySelectorAll("li")[0];
    const secondRow = root.querySelectorAll("li")[1];

    rows.set([second, first]);
    expect(root.textContent).toBe("BA");
    expect(root.querySelectorAll("li")[0]).toBe(secondRow);
    expect(root.querySelectorAll("li")[1]).toBe(firstRow);
    scope.suffix = "-two";
    rows.set([first, second]);
    expect(root.textContent).toBe("AB");
    expect(root.querySelectorAll("li")[0]).not.toBe(firstRow);
    expect(root.querySelectorAll("li")[1]).not.toBe(secondRow);
    handle.dispose();
  });

  it("rejects hydration when the existing root structure does not match", () => {
    const compiled = compileTemplate(`<p>{name}</p>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("b");
    root.textContent = "SSR";
    const before = root.outerHTML;

    const result = hydrate(root, module, { name: "Alice" });

    expect(result.ok).toBe(false);
    expect(root.outerHTML).toBe(before);
  });

  it("rejects unexpected hydration attributes and unsafe extra nodes", () => {
    const root = document.createElement("main");
    root.innerHTML = `<p>SSR</p><script>alert(1)</script>`;
    root.setAttribute("onclick", "alert(2)");
    const before = root.outerHTML;
    const module: ClientTemplateModule = {
      templateHtml: `<main><!----><p> </p></main>`,
      bind: () => undefined,
    };

    const result = hydrate(root, module);

    expect(result.ok).toBe(false);
    expect(root.outerHTML).toBe(before);
  });

  it("allows compiler-declared dynamic attributes during hydration", () => {
    const compiled = compileTemplate(`<main><p class:active={active} aria-label={label}>Hello</p></main>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const module: ClientTemplateModule = {
      templateHtml: generated.templateHtml,
      hydrationDynamicAttributes: generated.hydrationDynamicAttributes ?? [],
      bind: () => undefined,
    };
    const root = document.createElement("main");
    root.innerHTML = `<p class="active" aria-label="server">Hello</p>`;
    const scope = { name: "ignored", active: true, label: "client" };

    const result = hydrate(root, module, scope);

    expect(result.ok).toBe(true);
    expect(root.querySelector("p")?.getAttribute("aria-label")).toBe("server");
    if (result.ok) result.value.dispose();
  });

  it("hydrates SSR rows around static siblings", () => {
    const compiled = compileTemplate(
      `<ul><for each={items} key={item.id}><li class="row">{item.name}</li></for><li class="footer">Footer</li></ul>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const root = document.createElement("main");
    root.innerHTML = renderServerTemplate(compiled.value, {
      items: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });

    const result = hydrate(root, {
      templateHtml: compiled.value.client.templateHtml,
      hydrationDynamicRegions: compiled.value.client.hydrationDynamicRegions,
      bind: () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(root.textContent).toBe("ABFooter");
    if (result.ok) result.value.dispose();
  });

  it("binds a generated list module without consuming static siblings", () => {
    const compiled = compileTemplate(
      `<ul><for each={items} key={item.id}><li class="row">{item.name}</li></for><li class="footer">Footer</li></ul>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("main");
    root.innerHTML = renderServerTemplate(compiled.value, {
      items: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });
    const serverRows = Array.from(root.querySelectorAll("li.row"));

    const result = hydrate(root, module, {
      items: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(root.innerHTML).toBe(
      `<ul><!--tachyon-for--><li class="row">A</li><li class="row">B</li><!--/tachyon-for--><li class="footer">Footer</li></ul>`,
    );
    expect(root.querySelectorAll("li.row")[0]).toBe(serverRows[0]);
    expect(root.querySelectorAll("li.row")[1]).toBe(serverRows[1]);
    if (result.ok) result.value.dispose();
  });

  it("executes compiler-generated row store readers on the generic list path", () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><store count={row.count}/><span>{count}</span></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value);
    expect(generated).toContain("mountGeneratedKeyedList");
    const module = evaluateGeneratedClientModule(generated);
    const root = document.createElement("div");

    mount(root, module, { rows: [{ id: "a", count: 7 }] });

    expect(root.innerHTML).toBe(`<main><ul><!--tachyon-for--><li><span>7</span></li><!--/tachyon-for--></ul></main>`);
  });

  it("executes compiler-generated row component props and stores on the generic list path", () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><component name="Row" label={row.label}><li><store count={row.count}/><span>{label}:{count}</span></li></component></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const generated = generateClientModule(compiled.value);
    expect(generated).toContain('components: [{ path: [], name: "Row"');
    const module = evaluateGeneratedClientModule(generated);
    const root = document.createElement("div");

    mount(root, module, { rows: [{ id: "a", label: "A", count: 7 }] });

    expect(root.textContent).toBe("A:7");
  });

  it("keeps same-named stores in sibling components independent", () => {
    const compiled = compileTemplate(
      `<main><component name="Left"><span><store count={left}/>{count}</span></component><component name="Right"><span><store count={right}/>{count}</span></component></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("div");

    mount(root, module, { left: 1, right: 2 });

    expect(Array.from(root.querySelectorAll("span")).map((span) => span.textContent)).toEqual(["1", "2"]);
  });

  it("creates component branch stores when shown and recreates them after hiding", () => {
    const compiled = compileTemplate(
      `<main><component name="Panel"><section><if test={visible}><store count={init()}/><output>{count}</output></if></section></component></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const visible = createSignal(false);
    let initializations = 0;
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    const handle = mount(root, module, {
      visible,
      init: () => {
        initializations += 1;
        return initializations;
      },
    });

    expect(initializations).toBe(0);
    visible.set(true);
    expect(initializations).toBe(1);
    expect(root.querySelector("output")?.textContent).toBe("1");
    visible.set(false);
    expect(root.querySelector("output")).toBeNull();
    visible.set(true);
    expect(initializations).toBe(2);
    expect(root.querySelector("output")?.textContent).toBe("2");
    handle.dispose();
  });

  it("resolves binding paths across SSR hydration markers when a boundary has siblings", () => {
    const compiled = compileTemplate(
      `<main><section hydrate:id={panel}><p class:on={active}>{title}:{note}</p></section><h1>{title}</h1><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul><button on:click={go}>go</button></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, {
      panel: "p-1",
      active: true,
      title: "A",
      note: "n",
      rows: [{ id: 1, label: "one" }],
      go: () => undefined,
    });
    const title = createSignal("A");
    const rows = createSignal([{ id: 1, label: "one" }]);

    let clicks = 0;
    const result = hydrate(root, module, { panel: "p-1", active: true, title, note: "n", rows, go: () => clicks++ });
    if (!result.ok) throw new Error(result.error.message);
    root.querySelector("h1")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toBe(0);
    root.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toBe(1);
    title.set("B");
    expect(root.innerHTML).toContain("<h1>B</h1>");
    expect(root.querySelector("p")?.textContent).toBe("B:n");
    rows.set([
      { id: 1, label: "uno" },
      { id: 2, label: "two" },
    ]);
    expect(Array.from(root.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["uno", "two"]);
    result.value.dispose();
  });

  it("releases eager bindings when boundary creation fails so a retried hydrate does not double-bind", () => {
    const compiled = compileTemplate(
      `<main><button on:click={go}>go</button><section hydrate><p>{title}</p></section></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const code = generateClientModule(compiled.value, {
      reactive: true,
      hydrationChunkImports: { "td-h-1": "./chunk.js" },
    });
    let failCreation = true;
    const module = evaluateGeneratedClientModule(code, {
      "tachyon-dom/runtime/hydrate": {
        createLazyHydrationBoundary: (...args: unknown[]) =>
          failCreation
            ? { ok: false, error: { message: "synthetic boundary failure" } }
            : (hydrateRuntime.createLazyHydrationBoundary as (...inner: unknown[]) => unknown)(...args),
      },
    });
    const root = document.createElement("div");
    root.innerHTML = renderServerTemplate(compiled.value, { go: () => undefined, title: "T" });
    let clicks = 0;
    const scope = { go: () => clicks++, title: "T" };

    const failed = hydrate(root, module, scope);
    expect(failed.ok).toBe(false);
    root.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toBe(0);

    failCreation = false;
    const retried = hydrate(root, module, scope);
    expect(retried.ok).toBe(true);
    root.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).toBe(1);
    if (retried.ok) retried.value.dispose();
  });

  it("reports malformed boundary markers in preflight diagnostics", () => {
    document.body.innerHTML = `<main><div><!--tachyon-hydrate:cross:start--></div><section>C</section><!--tachyon-hydrate:cross:end--></main>`;
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing main.");
    expect(hydrateRuntime.diagnoseHydrationBoundaries(main, ["cross"]).map((diagnostic) => diagnostic.type)).toEqual([
      "malformed",
    ]);
  });

  it("rejects mounting a hydrate-only module before touching the DOM and refuses to hydrate a root twice", () => {
    const hydrateOnly = {
      hydrateOnly: true as const,
      templateHtml: "<p></p>",
      hydrate: () => () => undefined,
    };
    const root = document.createElement("div");
    root.innerHTML = "<b>keep</b>";

    expect(() => mount(root, hydrateOnly as never, {})).toThrow(/hydrate-only/);
    expect(root.innerHTML).toBe("<b>keep</b>");

    root.innerHTML = "<p></p>";
    const first = hydrate(root, hydrateOnly, {});
    expect(first.ok).toBe(true);
    const second = hydrate(root, hydrateOnly, {});
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain("already hydrated");
    if (first.ok) first.value.dispose();
    const third = hydrate(root, hydrateOnly, {});
    expect(third.ok).toBe(true);
    if (third.ok) third.value.dispose();
  });

  it("runs mount and hydrate cleanups once when the enclosing owner is disposed", () => {
    let mountCleanups = 0;
    let hydrateCleanups = 0;
    const module: ClientTemplateModule<Record<string, unknown>> = {
      templateHtml: "<p></p>",
      bind: () => () => mountCleanups++,
      hydrate: () => () => hydrateCleanups++,
    };
    const mountRoot = document.createElement("div");
    const hydrateRoot = document.createElement("div");
    hydrateRoot.innerHTML = "<p></p>";
    let mounted: ReturnType<typeof mount> | undefined;
    let hydrated: ReturnType<typeof mount> | undefined;
    const stop = createRoot((dispose) => {
      mounted = mount(mountRoot, module, {});
      const result = hydrate(hydrateRoot, module, {});
      if (!result.ok) throw new Error(result.error.message);
      hydrated = result.value;
      return dispose;
    });

    stop();

    expect(mountCleanups).toBe(1);
    expect(hydrateCleanups).toBe(1);
    expect(mounted?.disposed()).toBe(true);
    expect(hydrated?.disposed()).toBe(true);
    mounted?.dispose();
    hydrated?.dispose();
    expect(mountCleanups).toBe(1);
    expect(hydrateCleanups).toBe(1);
  });

  it("creates each declared store once per owner and keeps instances, shadowing, and branches independent", () => {
    const compiled = compileTemplate(
      `<main><store label={seed()}/><p>{label}</p><if test={show}><section><store local={seed()}/><span>{local}</span><input bind:value={local}></section></if><component name="Card" title={label}><article><store local={title}/><b>{local}</b></article></component></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    const scopeFor = (name: string, counter: { reads: number }) => {
      const show = createSignal(false);
      const scope = {
        seed: () => {
          counter.reads += 1;
          return name;
        },
        show,
        label: "shadowed by the top-level store",
      };
      return { scope, show };
    };
    const first = { reads: 0 };
    const second = { reads: 0 };
    const firstScope = scopeFor("first", first);
    const secondScope = scopeFor("second", second);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);

    let stopParent: (() => void) | undefined;
    let firstHandle: ReturnType<typeof mount> | undefined;
    createRoot((dispose) => {
      firstHandle = mount(firstRoot, module, firstScope.scope);
      stopParent = dispose;
    });
    const secondHandle = mount(secondRoot, module, secondScope.scope);

    // Top-level store: initial expression evaluated once per instance and the
    // hidden branch has not initialised its store yet. The component-owned
    // store is created once with its own value.
    expect(first.reads).toBe(1);
    expect(second.reads).toBe(1);
    expect(firstRoot.querySelector("p")?.textContent).toBe("first");
    expect(secondRoot.querySelector("p")?.textContent).toBe("second");
    expect(firstRoot.querySelector("b")?.textContent).toBe("first");
    expect(firstRoot.querySelector("span")).toBeNull();

    firstScope.show.set(true);
    expect(first.reads).toBe(2);
    expect(second.reads).toBe(1);
    const input = firstRoot.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing branch input.");
    input.value = "edited";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(firstRoot.querySelector("span")?.textContent).toBe("edited");
    // Shadowing: the branch-local store does not leak into the component's
    // store of the same name, nor into the other instance.
    expect(firstRoot.querySelector("b")?.textContent).toBe("first");
    expect(secondRoot.querySelector("span")).toBeNull();

    firstScope.show.set(false);
    expect(firstRoot.querySelector("span")).toBeNull();
    firstScope.show.set(true);
    // Re-entering the branch creates a fresh store from the initial expression.
    expect(first.reads).toBe(3);
    expect(firstRoot.querySelector("span")?.textContent).toBe("first");

    stopParent?.();
    expect(firstHandle?.disposed()).toBe(true);
    expect(() => firstHandle?.dispose()).not.toThrow();
    firstScope.show.set(false);
    expect(first.reads).toBe(3);
    secondHandle.dispose();
  });

  it("schedules compiler-generated row hydration boundaries and replays one interaction", async () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><button hydrate:id={row.id} hydrate:interaction="click" on:click={select}>{row.label}</button></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("div");
    const select = vi.fn();
    const scope = { rows: [{ id: "a", label: "A" }], select };
    root.innerHTML = renderServerTemplate(compiled.value, scope);
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing row button.");

    const result = hydrate(root, module, scope);
    expect(result.ok).toBe(true);
    button.click();
    await Promise.resolve();

    expect(select).toHaveBeenCalledTimes(1);
    if (result.ok) result.value.dispose();
  });

  // A row's boundary id is read from the row scope, so the bounded parent snapshot the compiler emits has to
  // carry the key it names. When it did not, the id resolved to undefined, the boundary was skipped, and
  // everything it owned bound at hydrate time instead of waiting for the interaction.
  it("defers a row hydration boundary whose id comes from the parent scope", async () => {
    const compiled = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li><button hydrate:id={boundaryId} hydrate:interaction="click" on:click={select}>{row.label}</button></li></for></ul></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("div");
    const select = vi.fn();
    let labelReads = 0;
    const row = {
      id: "a",
      get label() {
        labelReads++;
        return "A";
      },
    };
    const scope = { rows: [row], boundaryId: "row-a", select };
    root.innerHTML = renderServerTemplate(compiled.value, scope);
    const button = root.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing row button.");

    labelReads = 0;
    const result = hydrate(root, module, scope);
    expect(result.ok).toBe(true);
    expect(labelReads).toBe(0);

    button.click();
    await Promise.resolve();

    expect(select).toHaveBeenCalledTimes(1);
    expect(labelReads).toBeGreaterThan(0);
    if (result.ok) result.value.dispose();
  });

  it("compares static class tokens while allowing compiler-declared class tokens", () => {
    const compiled = compileTemplate(`<p class="btn" class:active={active}>Hello</p>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module: ClientTemplateModule = {
      templateHtml: compiled.value.client.templateHtml,
      hydrationDynamicAttributes: [{ path: [], name: "class", kind: "token" }],
      bind: () => undefined,
    };
    const root = document.createElement("main");
    root.innerHTML = `<p class="btn active">Hello</p>`;

    const hydrated = hydrate(root, module, { active: true });
    expect(hydrated.ok).toBe(true);
    if (hydrated.ok) hydrated.value.dispose();

    root.innerHTML = `<p class="wrong active">Hello</p>`;
    expect(hydrate(root, module, { active: true }).ok).toBe(false);
  });

  it("rejects unsafe children even when the expected element has no children", () => {
    const root = document.createElement("main");
    root.innerHTML = `<div><script>alert(1)</script></div>`;
    const before = root.outerHTML;

    const result = hydrate(root, { templateHtml: `<div></div>`, bind: () => undefined });

    expect(result.ok).toBe(false);
    expect(root.outerHTML).toBe(before);
  });

  it("mounts independent instances and disposes each one once", () => {
    const first = document.createElement("main");
    const second = document.createElement("main");
    const disposed: string[] = [];
    const module: ClientTemplateModule<{ name: string }> = {
      templateHtml: `<p></p>`,
      bind: (root, scope) => {
        root.textContent = scope.name;
        return () => disposed.push(scope.name);
      },
    };

    const firstHandle = mount(first, module, { name: "first" });
    const secondHandle = mount(second, module, { name: "second" });
    firstHandle.dispose();
    firstHandle.dispose();

    expect(first.textContent).toBe("first");
    expect(second.textContent).toBe("second");
    expect(disposed).toEqual(["first"]);
    secondHandle.dispose();
    expect(disposed).toEqual(["first", "second"]);
  });

  it("rolls back the original DOM when bind initialization fails", () => {
    const root = document.createElement("main");
    root.innerHTML = `<p>original</p>`;
    const original = root.firstChild;
    const module: ClientTemplateModule = {
      templateHtml: `<p>next</p>`,
      bind: () => {
        throw new Error("bind failed");
      },
    };

    expect(() => mount(root, module)).toThrow("bind failed");
    expect(root.firstChild).toBe(original);
    expect(root.textContent).toBe("original");
  });

  it("hydrates existing marked DOM and reports marker mismatch without replacing it", () => {
    const root = document.createElement("main");
    root.innerHTML = `<!--tachyon-hydrate:panel:start--><section>SSR</section><!--tachyon-hydrate:panel:end-->`;
    const before = root.innerHTML;
    const module: ClientTemplateModule = {
      templateHtml: `<section>client</section>`,
      hydrationBoundaries: [{ id: "panel", idKind: "static" }],
      bind: (element) => {
        element.setAttribute("data-bound", "yes");
      },
    };

    const hydrated = hydrate(root, module);
    expect(hydrated.ok).toBe(true);
    expect(root.innerHTML).toContain(`data-bound="yes"`);
    expect(root.innerHTML).not.toBe(before);
    if (hydrated.ok) hydrated.value.dispose();

    const broken = hydrate(root, { ...module, hydrationBoundaries: [{ id: "missing", idKind: "static" }] });
    expect(broken.ok).toBe(false);
    expect(root.innerHTML).toContain(`data-bound="yes"`);
  });

  it("accepts a legacy bind that does not return a cleanup", () => {
    const root = document.createElement("main");
    const handle = mount(root, { templateHtml: `<p>legacy</p>`, bind: () => undefined });

    expect(() => handle.dispose()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });

  it("cleans resources created before a mount bind failure", () => {
    const root = document.createElement("main");
    const source = createSignal(0);
    let runs = 0;
    const module: ClientTemplateModule = {
      templateHtml: `<p>next</p>`,
      bind: () => {
        effect(() => {
          source();
          runs++;
        });
        throw new Error("bind failed after setup");
      },
    };

    expect(() => mount(root, module)).toThrow("bind failed after setup");
    source.set(1);

    expect(runs).toBe(1);
  });

  it("rolls back generated eager listeners when a later binding throws", () => {
    const compiled = compileTemplate(`<main><button on:click={go}>go</button><p>{message}</p></main>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value));
    const root = document.createElement("div");
    root.innerHTML = module.templateHtml;
    const bindRoot = root.firstElementChild;
    const button = root.querySelector("button");
    if (!(bindRoot instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("Missing generated binding root.");
    }
    let calls = 0;
    const failingScope: Record<string, unknown> = {
      go: () => calls++,
    };
    Object.defineProperty(failingScope, "message", {
      get: () => {
        throw new Error("binding read failed");
      },
    });

    expect(() => module.bind(bindRoot, failingScope)).toThrow("binding read failed");
    button.click();
    expect(calls).toBe(0);

    const cleanup = module.bind(bindRoot, { go: () => calls++, message: "ready" });
    button.click();
    expect(calls).toBe(1);
    cleanup?.();
  });

  it("cleans resources created before a hydrate bind failure", () => {
    const root = document.createElement("main");
    root.innerHTML = `<p>SSR</p>`;
    const source = createSignal(0);
    let runs = 0;
    const module: ClientTemplateModule = {
      templateHtml: `<p>client</p>`,
      bind: () => {
        effect(() => {
          source();
          runs++;
        });
        throw new Error("hydrate failed after setup");
      },
    };

    const result = hydrate(root, module);
    source.set(1);

    expect(result.ok).toBe(false);
    expect(runs).toBe(1);
  });
});

it("preserves this and normalized identifier references through the Vite SFC transform", async () => {
  const plugin = tachyonDom({ reactive: true });
  if (typeof plugin.transform !== "function") throw new Error("Missing transform hook");
  const result = await plugin.transform.call(
    {
      error(message: string): never {
        throw new Error(message);
      },
    } as never,
    String.raw`<script setup>const secret = "READY"; function label() { return this.secret; } const 件数 = 7; const count = 8;</script><p>{label()}:{件数}:{\u0063ount}</p>`,
    "/src/sfc-scope-regression.td?client",
  );
  if (!result || typeof result !== "object" || typeof result.code !== "string") throw new Error("Missing module");
  const module = evaluateGeneratedClientModule(result.code.replace(/^export \{[^}]*\};?$/gm, ""));
  const root = document.createElement("div");
  const handle = mount(root, module);
  try {
    expect(root.textContent).toBe("READY:7:8");
  } finally {
    handle.dispose();
  }
});
