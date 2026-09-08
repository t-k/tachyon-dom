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
