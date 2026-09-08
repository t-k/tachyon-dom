import { expect, it } from "vitest";
import { compileTachyonSfc, transformSfcScript } from "../src/compiler/sfc";
import { generateClientModule } from "../src/compiler";
import { createTemplateComponent } from "../src/runtime/component";
import { evaluateGeneratedClientModule } from "./generated-client-module";

it.each([
  { name: "plain", script: "", store: "", suffix: "", body: "{label}" },
  {
    name: "setup",
    script: '<script setup>inputScope.started(); const suffix = "!";</script>',
    store: "",
    suffix: "!",
    body: "{label + suffix}",
  },
  {
    name: "store",
    script: '<script setup>inputScope.started(); const suffix = "!";</script>',
    store: "<store count={0}/>",
    suffix: "!",
    body: "{label + suffix}",
  },
])("updates compiled $name components without resetting their instance", async ({ script, store, suffix, body }) => {
  const compiled = compileTachyonSfc(
    `${script}<main>${store}<p>${body}</p>${store ? "<input bind:value={count}/><output>{count}</output>" : ""}</main>`,
  );
  if (!compiled.ok) throw new Error(compiled.error.message);
  const transformed = transformSfcScript(compiled.value.descriptor.script);
  if (!transformed.ok) throw new Error(transformed.error.message);
  const client = evaluateGeneratedClientModule(
    transformed.value.code +
      generateClientModule(compiled.value.template, {
        reactive: true,
        ...(transformed.value.defaultScopeName ? { defaultScopeName: transformed.value.defaultScopeName } : {}),
      }),
  );
  let starts = 0;
  const started = () => {
    starts++;
  };
  const component = createTemplateComponent<{ label: string; started: () => void }>({ client });
  const root = document.createElement("div");
  const otherRoot = document.createElement("div");
  const first = component.mount(root, { label: "before", started });
  const second = component.mount(otherRoot, { label: "other", started });
  const paragraph = root.querySelector("p");
  const input = root.querySelector("input");
  try {
    expect(paragraph?.textContent).toBe(`before${suffix}`);
    if (input) {
      input.value = "7";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
      expect(root.querySelector("output")?.textContent).toBe("7");
    }
    first.update({ label: "after", started });
    await Promise.resolve();
    expect(paragraph?.textContent).toBe(`after${suffix}`);
    expect(root.querySelector("p")).toBe(paragraph);
    expect(otherRoot.querySelector("p")?.textContent).toBe(`other${suffix}`);
    expect(starts).toBe(script ? 2 : 0);
    if (input) {
      expect(root.querySelector("input")).toBe(input);
      expect(root.querySelector("output")?.textContent).toBe("7");
      expect(otherRoot.querySelector("output")?.textContent).toBe("0");
    }
    first.dispose();
    first.update({ label: "disposed", started });
    expect(paragraph?.textContent).toBe(`after${suffix}`);
    if (input) {
      input.value = "8";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
      expect(root.querySelector("output")?.textContent ?? "7").toBe("7");
    }
  } finally {
    first.dispose();
    second.dispose();
  }
});

it("keeps form writes reactive and local when the input scope is a plain object", async () => {
  const compiled = compileTachyonSfc(
    "<main><store count={0}/><input bind:value={label}/><output>{label}</output></main>",
  );
  if (!compiled.ok) throw new Error(compiled.error.message);
  const client = evaluateGeneratedClientModule(generateClientModule(compiled.value.template, { reactive: true }));
  const scope = { label: "before" };
  const root = document.createElement("div");
  const { mount } = await import("../src/runtime/mount");
  const handle = mount(root, client, scope);
  try {
    const input = root.querySelector("input")!;
    input.value = "after";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    expect(root.querySelector("output")?.textContent).toBe("after");
    expect(scope.label).toBe("before");
  } finally {
    handle.dispose();
  }
});

it("accepts new props after local form edits without resurrecting previous overrides", async () => {
  const compiled = compileTachyonSfc(
    "<main><store count={0}/><input bind:value={label}/><output>{label}</output></main>",
  );
  if (!compiled.ok) throw new Error(compiled.error.message);
  const client = evaluateGeneratedClientModule(generateClientModule(compiled.value.template, { reactive: true }));
  const component = createTemplateComponent<{ label?: string }>({ client });
  const root = document.createElement("div");
  const handle = component.mount(root, {});
  try {
    const input = root.querySelector("input")!;
    handle.update({ label: "before" });
    input.value = "local";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    expect(root.querySelector("output")?.textContent).toBe("local");
    for (const label of ["after", "before"]) {
      handle.update({ label });
      expect(root.querySelector("output")?.textContent).toBe(label);
      expect(input.value).toBe(label);
    }
    handle.update({});
    expect(root.querySelector("output")?.textContent).toBe("");
  } finally {
    handle.dispose();
  }
});

it.each(["preserve", "condense"] as const)(
  "coalesces static text around erased stores under %s whitespace",
  async (whitespace) => {
    const { compileTemplate, renderServerTemplate } = await import("../src/compiler");
    const { mount, hydrate } = await import("../src/runtime/mount");
    const compiled = compileTemplate(
      "<main> <store count={7}/> <store other={0}/> <section><button>{count}</button></section></main>",
      { whitespace },
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const client = evaluateGeneratedClientModule(generateClientModule(compiled.value, { reactive: true }));
    for (const ssr of [false, true]) {
      const root = document.createElement("div");
      if (ssr) root.innerHTML = renderServerTemplate(compiled.value, {});
      const existing = root.querySelector("button");
      const result = ssr ? hydrate(root, client, {}) : { ok: true as const, value: mount(root, client, {}) };
      if (!result.ok) throw new Error(result.error.message);
      try {
        expect(root.querySelector("button")?.textContent).toBe("7");
        if (ssr) expect(root.querySelector("button")).toBe(existing);
      } finally {
        result.value.dispose();
      }
    }
  },
);

it("does not turn literal brace fragments around a store into an expression", async () => {
  const { compileTemplate } = await import("../src/compiler");
  const compiled = compileTemplate("<main>{<store x={0}/>x}</main>");
  if (!compiled.ok) throw new Error(compiled.error.message);
  expect(compiled.value.client.templateHtml).toBe("<main>{x}</main>");
  expect(compiled.value.client.bindings).toHaveLength(0);
});

it.each([false, true])(
  "retains generated hydration state and releases repeated instances with setup=%s",
  async (setup) => {
    const { renderServerTemplate } = await import("../src/compiler");
    const { createRuntimeDiagnostics } = await import("../src/runtime/diagnostics");
    const compiled = compileTachyonSfc(
      `${setup ? '<script setup>inputScope.started(); const local = "ready";</script>' : ""}<main><store count={0}/><p>{label}</p><input bind:value={count}/><output>{count}</output></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const script = transformSfcScript(compiled.value.descriptor.script);
    if (!script.ok) throw new Error(script.error.message);
    const client = evaluateGeneratedClientModule(
      script.value.code +
        generateClientModule(compiled.value.template, {
          reactive: true,
          hydrateOnly: true,
          ...(script.value.defaultScopeName ? { defaultScopeName: script.value.defaultScopeName } : {}),
        }),
    );
    let starts = 0;
    const started = () => {
      starts++;
    };
    const component = createTemplateComponent<{ label: string; started: () => void }>({ client });
    const diagnostics = createRuntimeDiagnostics();
    const baseline = diagnostics.snapshot();
    try {
      for (let index = 0; index < 30; index++) {
        const root = document.createElement("div");
        root.innerHTML = renderServerTemplate(compiled.value.template, { label: "before" });
        const original = root.querySelector("p");
        const result = component.hydrate(root, { label: "before", started });
        if (!result.ok) throw new Error(result.error.message);
        try {
          const input = root.querySelector("input")!;
          input.value = "7";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await Promise.resolve();
          result.value.update({ label: "after", started });
          expect(original?.textContent).toBe("after");
          expect(root.querySelector("p")).toBe(original);
          expect(root.querySelector("output")?.textContent).toBe("7");
        } finally {
          result.value.dispose();
        }
        expect(diagnostics.snapshot()).toEqual(baseline);
      }
      expect(starts).toBe(setup ? 30 : 0);
    } finally {
      diagnostics.dispose();
    }
  },
);
