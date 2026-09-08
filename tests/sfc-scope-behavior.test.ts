import { expect, it } from "vitest";
import {
  compileTachyonSfc,
  sfcSetupScopeName,
  templateScopeIdentifiers,
  transformSfcScript,
} from "../src/compiler/sfc";
import { generateClientModule, renderServerTemplate } from "../src/compiler";
import { hydrate, mount } from "../src/runtime/mount";
import { createSignal } from "../src/runtime/signal";
import { evaluateGeneratedClientModule } from "./generated-client-module";
import { importedLabel } from "./fixtures/sfc-scope/shared";
import { sfcScopeCases, sfcScopeSource } from "./fixtures/sfc-scope/cases";

it.each(sfcScopeCases)("preserves rendering, events, and cleanup for $name", async (fixture) => {
  const compiled = compileTachyonSfc(sfcScopeSource(fixture));
  if (!compiled.ok) throw new Error(compiled.error.message);
  for (const narrow of [false, true]) {
    const transformed = transformSfcScript(
      compiled.value.descriptor.script,
      narrow
        ? {
            templateIdentifiers: templateScopeIdentifiers(compiled.value.template),
          }
        : {},
    );
    if (!transformed.ok) throw new Error(transformed.error.message);
    expect(transformed.value.exposedBindings.length < transformed.value.setupBindings.length).toBe(
      narrow && fixture.narrows,
    );
    const code = transformed.value.code.replace(/^import .*$/gm, "").replace(/export \{[^}]*\};?/g, "");
    const scope = new Function("createSignal", "label", `${code}; return ${sfcSetupScopeName}();`)(
      createSignal,
      importedLabel,
    );
    const module = evaluateGeneratedClientModule(generateClientModule(compiled.value.template, { reactive: true }));
    const root = document.createElement("div");
    const deferred = "deferred" in fixture;
    if (deferred) root.innerHTML = renderServerTemplate(compiled.value.template, scope);
    const result = deferred ? hydrate(root, module, scope) : { ok: true as const, value: mount(root, module, scope) };
    if (!result.ok) throw new Error(result.error.message);
    try {
      expect(root.querySelector("p")?.textContent).toBe("READY");
      const button = root.querySelector("button")!;
      button.click();
      await Promise.resolve();
      expect(scope.readClicks()).toBe(1);
      expect(button.textContent).toBe("1");
      result.value.dispose();
      button.click();
      expect(scope.readClicks()).toBe(1);
    } finally {
      result.value.dispose();
    }
  }
});

it.each([false, true])("preserves external method scope when overriding=%s", (override) => {
  const compiled = compileTachyonSfc(`<script setup>
const secret = "READY";
${override ? 'const label = () => "LOCAL";' : ""}
</script><p>{label()}</p>`);
  if (!compiled.ok) throw new Error(compiled.error.message);
  for (const narrow of [false, true]) {
    const script = transformSfcScript(
      compiled.value.descriptor.script,
      narrow
        ? {
            templateIdentifiers: templateScopeIdentifiers(compiled.value.template),
          }
        : {},
    );
    if (!script.ok) throw new Error(script.error.message);
    const module = evaluateGeneratedClientModule(
      script.value.code +
        generateClientModule(compiled.value.template, {
          reactive: true,
          instrumentBindings: false,
          defaultScopeName: script.value.defaultScopeName!,
        }),
    );
    const root = document.createElement("div");
    const view = mount(root, module, {
      label() {
        return this.secret;
      },
    } as Record<string, unknown>);
    try {
      expect(root.textContent).toBe("READY");
    } finally {
      view.dispose();
    }
  }
});

it("keeps full bindings for empty external input and preserves setup input defaults", () => {
  for (const body of ['const secret = "READY";', 'const secret = inputScope.secret ?? "READY";']) {
    const compiled = compileTachyonSfc(`<script setup>${body}</script><p>static</p>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const script = transformSfcScript(compiled.value.descriptor.script, { templateIdentifiers: new Set() });
    if (!script.ok) throw new Error(script.error.message);
    const factory = new Function(`${script.value.code}; return ${sfcSetupScopeName};`)();
    expect(factory({}).secret).toBe("READY");
    expect(factory()).toEqual(body.includes("inputScope") ? { secret: "READY" } : {});
  }
});
