import type { TemplateExplanation } from "./compiler/explain.js";
import type {
  RuntimeDiagnostics,
  RuntimeDiagnosticsEvent,
  RuntimeDiagnosticsSnapshot,
  TemplateBindingLocation,
} from "./runtime/diagnostics.js";

export type InspectorTemplateExplanation = {
  templateId: string;
  explanation: TemplateExplanation;
};

export type InspectorReportV1 = {
  schemaVersion: 1;
  static: { templates: InspectorTemplateExplanation[] };
  observed: {
    snapshot: RuntimeDiagnosticsSnapshot;
    liveBindings: TemplateBindingLocation[];
    lifecycleEvents?: RuntimeDiagnosticsEvent[];
  };
};

export type InspectorReportOptions = {
  templates?: readonly InspectorTemplateExplanation[];
  includeLifecycleEvents?: boolean;
};

/** Captures compiler decisions and opt-in runtime observations as value-free, versioned JSON data. */
export const createInspectorReport = (
  diagnostics: RuntimeDiagnostics,
  options: InspectorReportOptions = {},
): InspectorReportV1 => ({
  schemaVersion: 1,
  static: {
    templates: (options.templates ?? []).map(({ templateId, explanation }) => ({
      templateId,
      explanation: {
        regions: explanation.regions.map((region) => ({
          kind: region.kind,
          path: [...region.path],
          runtime: region.runtime,
          reasons: [...region.reasons],
        })),
        runtimeImports: [...explanation.runtimeImports],
        hydrationDiagnostics: [...explanation.hydrationDiagnostics],
      },
    })),
  },
  observed: {
    snapshot: { ...diagnostics.snapshot() },
    liveBindings: diagnostics.liveBindings().map((binding) => ({ ...binding, path: [...binding.path] })),
    ...(options.includeLifecycleEvents
      ? { lifecycleEvents: diagnostics.events().map((event) => ({ ...event, snapshot: { ...event.snapshot } })) }
      : {}),
  },
});
