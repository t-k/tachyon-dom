import { err, ok, type Result } from "./result.js";

const fixedDangerousAttributeNames = new Set(["srcdoc", "innerhtml", "outerhtml"]);

export const isDangerousAttributeName = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return normalized.startsWith("on") || fixedDangerousAttributeNames.has(normalized);
};

export const validateAttributeName = (name: string): Result<string, TypeError> =>
  isDangerousAttributeName(name) ? err(new TypeError(`Dangerous attribute is not supported: ${name}.`)) : ok(name);
