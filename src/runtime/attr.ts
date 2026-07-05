const dangerousPropertyNames = new Set(["innerhtml", "outerhtml", "srcdoc"]);

const shouldReflectProperty = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return !normalized.startsWith("on") && !dangerousPropertyNames.has(normalized);
};

export const setAttributeValue = (element: Element, name: string, value: unknown): void => {
  const reflectProperty = shouldReflectProperty(name);
  if (value == null || value === false) {
    element.removeAttribute(name);
    if (reflectProperty && name in element) {
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
  if (!reflectProperty) {
    element.removeAttribute(name);
    return;
  }
  if (value === true) {
    element.setAttribute(name, "");
  } else {
    element.setAttribute(name, String(value));
  }
  if (name in element) {
    try {
      (element as unknown as Record<string, unknown>)[name] = value;
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

export const setRef = (scope: Record<string, unknown>, expression: string, element: Element): void => {
  const parts = expression.split(".");
  let current: Record<string, unknown> = scope;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next == null || typeof next !== "object") {
      return;
    }
    current = next as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (last) {
    current[last] = element;
  }
};
