import type { TransformedSfcScript } from "../src/compiler/sfc";

export const checkImmutableTransform = (value: TransformedSfcScript) => {
  // @ts-expect-error Shared transform properties are immutable.
  value.code += "\n// instrumentation";
  // @ts-expect-error Shared binding arrays are immutable.
  value.setupBindings.push("extra");
  // @ts-expect-error Shared exposed arrays are immutable.
  value.exposedBindings.push("extra");
  // @ts-expect-error Shared binding elements are immutable.
  value.setupBindings[0] = "extra";
  // @ts-expect-error Shared metadata is immutable.
  value.scopeEmission = "full";
  const editable = { ...value, setupBindings: [...value.setupBindings], exposedBindings: [...value.exposedBindings] };
  editable.code += "\n// instrumentation";
  editable.setupBindings.push("extra");
  editable.exposedBindings.push("extra");
  return editable;
};
