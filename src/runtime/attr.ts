import { validateAttributeName } from "../attribute-policy.js";
import { sanitizeElementUrlAttributes } from "../url-policy.js";
import { setClassValue } from "./class.js";

const prospectiveAttributes = (element: Element, name: string, value: string): Record<string, string> => {
  const normalizedName = name.toLowerCase();
  const attributes = Object.fromEntries(
    [...element.attributes]
      .filter((attribute) => attribute.name.toLowerCase() !== normalizedName)
      .map((attribute) => [attribute.name, attribute.value]),
  );
  attributes[name] = value;
  return attributes;
};

export const setAttributeValue = (element: Element, name: string, value: unknown): void => {
  const validatedName = validateAttributeName(name);
  if (!validatedName.ok) {
    throw validatedName.error;
  }
  if (name.toLowerCase() === "class") {
    setClassValue(element, value);
    return;
  }
  if (value == null || value === false) {
    element.removeAttribute(name);
    if (name in element) {
      try {
        const properties = element as unknown as Record<string, unknown>;
        const current = properties[name];
        if (typeof current === "boolean") {
          properties[name] = false;
        } else if (name === "value" && typeof current === "string") {
          properties[name] = "";
        }
      } catch {
        // Some readonly DOM properties throw on assignment.
      }
    }
    return;
  }
  let resolvedValue = value;
  if (value === true) {
    const result = sanitizeElementUrlAttributes(element.localName, prospectiveAttributes(element, name, ""));
    if (!result.ok) throw result.error;
    element.setAttribute(name, "");
  } else {
    const text = String(value);
    const result = sanitizeElementUrlAttributes(element.localName, prospectiveAttributes(element, name, text));
    if (!result.ok) throw result.error;
    resolvedValue = result.value[name] ?? text;
    element.setAttribute(name, String(resolvedValue));
  }
  if (name in element) {
    try {
      (element as unknown as Record<string, unknown>)[name] = resolvedValue;
    } catch {
      // Some readonly DOM properties throw on assignment.
    }
  }
};

export const setStyleValue = (element: Element, name: string, value: unknown): void => {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
    return;
  }
  element.style.setProperty(name, value == null || value === false ? "" : String(value));
};

/**
 * Writes an element into the ref the compiler resolved, and clears it on dispose only while it still holds that
 * element.
 *
 * The container is resolved once, here, and captured. A row rebinds against a scope that already points at its
 * new item, so re-resolving the container on the way out would clear the ref from whichever object the scope
 * happens to name then and leave the element on the one it was written into. The container reader and the
 * property name come from the generated module, so nothing here parses a path.
 */
export const bindRef = (
  scope: Record<string, unknown>,
  owner: (scope: Record<string, unknown>) => unknown,
  key: string,
  element: Element,
): (() => void) => {
  const target = owner(scope);
  if (target == null || typeof target !== "object") return () => undefined;
  const container = target as Record<string, unknown>;
  container[key] = element;
  return () => {
    if (container[key] === element) container[key] = undefined;
  };
};

export const setRef = (scope: Record<string, unknown>, expression: string, element: Element): (() => void) => {
  const parts = expression.split(".");
  let current: Record<string, unknown> = scope;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next == null || typeof next !== "object") {
      return () => undefined;
    }
    current = next as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (!last) return () => undefined;
  current[last] = element;
  const target = current;
  return () => {
    if (target[last] === element) target[last] = undefined;
  };
};
