import { validateAttributeName } from "../attribute-policy.js";
import { sanitizeUrlAttributeValue, urlPurposeForAttribute } from "../url-policy.js";
import { setClassValue } from "./class.js";

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
    element.setAttribute(name, "");
  } else {
    const text = String(value);
    resolvedValue = urlPurposeForAttribute(element.localName, name)
      ? sanitizeUrlAttributeValue(element.localName, name, text)
      : text;
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
