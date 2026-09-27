import { describe, expect, it } from "vitest";
import { compileTemplate } from "../src/compiler";
import { explainCompiledTemplate } from "../src/compiler/explain";
import { createInspectorReport } from "../src/inspector";
import { createRuntimeDiagnostics } from "../src/runtime/diagnostics";
import { mount } from "../src/runtime/mount";
import { createRoot, createSignal } from "../src/runtime/signal";
import { generateClientModule } from "../src/compiler";
import { evaluateGeneratedClientModule } from "./generated-client-module";

describe("Inspector report", () => {
  it("separates compiler decisions from observed bindings in versioned JSON without values", () => {
    const templateId = "src/secret-panel.td";
    const compiled = compileTemplate(`<main><p>{secret}</p><if test={shown}><span>Visible</span></if></main>`);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const explanation = explainCompiledTemplate(compiled.value);
    const module = evaluateGeneratedClientModule(
      generateClientModule(compiled.value, { reactive: true, templateId, sourceRevision: "revision" }),
    );
    const diagnostics = createRuntimeDiagnostics();
    const root = document.createElement("div");
    const shown = createSignal(false);
    const handle = mount(root, module, { secret: "private-token-123", shown });

    try {
      const report = createInspectorReport(diagnostics, { templates: [{ templateId, explanation }] });
      expect(report.schemaVersion).toBe(1);
      expect(report.static.templates[0]?.explanation.regions[0]?.runtime).toBe(
        "tachyon-dom/runtime/conditional-core",
      );
      expect(report.observed.snapshot.effects).toBeGreaterThan(0);
      expect(report.observed.liveBindings.some((binding) => binding.templateId === templateId)).toBe(true);
      expect(report.observed.liveBindings.some((binding) => binding.path.join(".") === "0.0")).toBe(true);
      expect(report.observed).not.toHaveProperty("lifecycleEvents");
      expect(JSON.stringify(report)).not.toContain("private-token-123");

      explanation.regions[0]?.reasons.push("changed after capture");
      expect(JSON.stringify(report)).not.toContain("changed after capture");
    } finally {
      handle.dispose();
    }

    const after = createInspectorReport(diagnostics);
    expect(after.observed.liveBindings).toEqual([]);
    diagnostics.dispose();
  });

  it("includes lifecycle events only when requested and copies their data", () => {
    const diagnostics = createRuntimeDiagnostics();
    const report = createInspectorReport(diagnostics, { includeLifecycleEvents: true });
    expect(report.observed.lifecycleEvents).toEqual([]);

    const dispose = createRoot((disposeRoot) => disposeRoot);
    expect(diagnostics.events().length).toBeGreaterThan(0);
    expect(report.observed.lifecycleEvents).toEqual([]);
    const activeReport = createInspectorReport(diagnostics, { includeLifecycleEvents: true });
    expect(activeReport.observed.lifecycleEvents).toEqual(diagnostics.events());
    expect(activeReport.observed.lifecycleEvents?.[0]?.snapshot.owners).toBeGreaterThan(0);
    dispose();
    expect(activeReport.observed.lifecycleEvents?.[0]?.snapshot.owners).toBeGreaterThan(0);
    diagnostics.dispose();
  });

  it("preserves static paths, reasons, imports, and hydration diagnostics in a detached report", () => {
    const diagnostics = createRuntimeDiagnostics();
    const explanation = {
      regions: [
        {
          kind: "list" as const,
          path: [2, 1],
          runtime: "tachyon-dom/runtime/list" as const,
          reasons: ["row has a store"],
        },
      ],
      runtimeImports: ["tachyon-dom/runtime/list"],
      hydrationDiagnostics: ["dynamic region cannot hydrate"],
    };
    const report = createInspectorReport(diagnostics, { templates: [{ templateId: "list.td", explanation }] });

    expect(report.static.templates).toEqual([{ templateId: "list.td", explanation }]);
    explanation.regions[0].path[0] = 9;
    explanation.regions[0].reasons[0] = "changed";
    explanation.runtimeImports[0] = "changed";
    explanation.hydrationDiagnostics[0] = "changed";
    expect(report.static.templates[0]?.explanation).toEqual({
      regions: [
        {
          kind: "list",
          path: [2, 1],
          runtime: "tachyon-dom/runtime/list",
          reasons: ["row has a store"],
        },
      ],
      runtimeImports: ["tachyon-dom/runtime/list"],
      hydrationDiagnostics: ["dynamic region cannot hydrate"],
    });
    diagnostics.dispose();
  });
});
