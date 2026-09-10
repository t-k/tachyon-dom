import type { ClientBinding, CompiledTemplate, ConditionalBinding, ListBinding } from "./types.js";
import { generateClientModule, isTextOnlyList, usesConditionalCore } from "./targets/client.js";

/**
 * One `<for>` or `<if>` region of a compiled template with the client runtime module the compiler chose for
 * it. `reasons` is empty when the lightweight module was chosen; otherwise each entry names one feature of the
 * region that requires the generic module. Removing every listed feature moves the region back to the
 * lightweight path. Both paths have the same observable meaning; they differ in size only.
 */
export type TemplateRegionExplanation = {
  kind: "list" | "conditional";
  /**
   * Path recorded on the client binding: for a conditional the path of its anchor, for a list the path of the
   * parent element whose child region the rows occupy.
   */
  path: number[];
  runtime:
    | "tachyon-dom/runtime/list-text"
    | "tachyon-dom/runtime/list"
    | "tachyon-dom/runtime/conditional-core"
    | "tachyon-dom/runtime/conditional";
  reasons: string[];
};

export type TemplateExplanation = {
  regions: TemplateRegionExplanation[];
  /** Every `tachyon-dom/runtime/*` module the generated client module imports. */
  runtimeImports: string[];
  /** Hydration constraints the compiler already knows about; `hydrate()` reports the same messages at runtime. */
  hydrationDiagnostics: string[];
};

const bindingFeature = (binding: ClientBinding): string => {
  switch (binding.kind) {
    case "model":
      return `bind:${binding.property}={${binding.expression}}`;
    case "ref":
      return `ref={${binding.expression}}`;
    case "style":
      return `style:${binding.name}={${binding.expression}}`;
    case "list":
      return `a nested <for each={${binding.each}}>`;
    case "if":
      return `a nested <if test={${binding.test}}>`;
    case "attr":
      return `${binding.name}={${binding.expression}}`;
    case "class":
      return `class:${binding.className}={${binding.expression}}`;
    case "event":
      return `on:${binding.eventName}={${binding.handler}}`;
    case "text":
      return `{${binding.expression}}`;
  }
};

const regionMetadataReasons = (binding: ListBinding | ConditionalBinding): string[] => {
  const reasons: string[] = [];
  if ((binding.stores?.length ?? 0) > 0)
    reasons.push(`it declares <store> (${binding.stores?.map((store) => store.name).join(", ")})`);
  if ((binding.components?.length ?? 0) > 0) reasons.push(`it contains <component> boundaries`);
  if ((binding.hydrationBoundaries?.length ?? 0) > 0) reasons.push(`it contains hydration boundaries`);
  return reasons;
};

const textListKinds = new Set(["text", "class", "attr", "event"]);

const listReasons = (binding: ListBinding): string[] => {
  const reasons = regionMetadataReasons(binding);
  for (const child of binding.bindings) {
    if (!textListKinds.has(child.kind)) reasons.push(`a row uses ${bindingFeature(child)}`);
  }
  if (binding.bindings.length === 0) reasons.push("rows have no dynamic bindings");
  else if (binding.bindings.every((child) => child.kind === "event")) reasons.push("rows contain only event bindings");
  return reasons;
};

const conditionalCoreKinds = new Set(["text", "class", "event", "attr", "style"]);

const conditionalReasons = (binding: ConditionalBinding): string[] => {
  const reasons = regionMetadataReasons(binding);
  for (const child of binding.bindings) {
    if (!conditionalCoreKinds.has(child.kind)) reasons.push(`the branch uses ${bindingFeature(child)}`);
  }
  return reasons;
};

const collectRegions = (
  bindings: readonly ClientBinding[],
  into: TemplateRegionExplanation[],
  nestedIn: "<for>" | "<if>" | undefined,
): void => {
  for (const binding of bindings) {
    if (binding.kind === "list") {
      // A region nested in a row or branch is mounted by the generic list runtime through its parent's
      // descriptor, whatever its own bindings are; only a top-level list can take the text-only path.
      const textOnly = nestedIn === undefined && isTextOnlyList(binding);
      const reasons = textOnly
        ? []
        : nestedIn
          ? [`it is nested in ${nestedIn}; nested lists always use the generic list runtime`]
          : listReasons(binding);
      into.push({
        kind: "list",
        path: [...binding.path],
        runtime: textOnly ? "tachyon-dom/runtime/list-text" : "tachyon-dom/runtime/list",
        reasons,
      });
      collectRegions(binding.bindings, into, "<for>");
    } else if (binding.kind === "if") {
      const core = usesConditionalCore(binding);
      into.push({
        kind: "conditional",
        path: [...binding.path],
        runtime: core ? "tachyon-dom/runtime/conditional-core" : "tachyon-dom/runtime/conditional",
        reasons: core ? [] : conditionalReasons(binding),
      });
      collectRegions(binding.bindings, into, "<if>");
    }
  }
};

const runtimeImportPattern = /from "(tachyon-dom\/runtime\/[a-z-]+)"/g;

/**
 * Explains the cost decisions the client target made for a compiled template: which runtime module each
 * `<for>` and `<if>` region uses and why, which runtime modules the module imports, and the hydration
 * constraints the compiler recorded.
 */
export const explainCompiledTemplate = (template: CompiledTemplate): TemplateExplanation => {
  const regions: TemplateRegionExplanation[] = [];
  collectRegions(template.client.bindings, regions, undefined);
  const runtimeImports = [
    ...new Set(
      Array.from(generateClientModule(template).matchAll(runtimeImportPattern), (match) => match[1] as string),
    ),
  ];
  return {
    regions,
    runtimeImports,
    hydrationDiagnostics: [...(template.client.hydrationDynamicRegionErrors ?? [])],
  };
};

const pathLabel = (path: readonly number[]): string => (path.length === 0 ? "root" : `root.${path.join(".")}`);

export const formatTemplateExplanation = (explanation: TemplateExplanation): string => {
  const lines: string[] = [];
  if (explanation.regions.length === 0) lines.push("No <for> or <if> regions.");
  for (const region of explanation.regions) {
    const where =
      region.kind === "list" ? `<for> under ${pathLabel(region.path)}` : `<if> at ${pathLabel(region.path)}`;
    lines.push(`${where} uses ${region.runtime}.`);
    if (region.reasons.length > 0) {
      lines.push("  The lightweight module was not chosen because:");
      for (const reason of region.reasons) lines.push(`    - ${reason}`);
    }
  }
  lines.push("");
  lines.push(
    explanation.runtimeImports.length === 0
      ? "The client module imports no runtime modules."
      : `Runtime imports: ${explanation.runtimeImports.join(", ")}`,
  );
  if (explanation.hydrationDiagnostics.length > 0) {
    lines.push("");
    lines.push("Hydration diagnostics:");
    for (const diagnostic of explanation.hydrationDiagnostics) lines.push(`  - ${diagnostic}`);
  }
  return `${lines.join("\n")}\n`;
};
