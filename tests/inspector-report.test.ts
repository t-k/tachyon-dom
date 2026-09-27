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
    expect(createInspectorReport(diagnostics, { includeLifecycleEvents: true }).observed.lifecycleEvents?.length).toBeGreaterThan(
      0,
    );
    dispose();
    diagnostics.dispose();
  });
});
