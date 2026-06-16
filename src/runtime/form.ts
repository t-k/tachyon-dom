export type BoundControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export const setControlValue = (element: BoundControl, property: "value" | "checked", value: unknown): void => {
  if (property === "checked" && element instanceof HTMLInputElement) {
    element.checked = Boolean(value);
    return;
  }
  element.value = value == null ? "" : String(value);
};

export const bindControl = (
  element: Element,
  property: "value" | "checked",
  read: () => unknown,
  write: (value: unknown) => void,
): (() => void) => {
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    )
  ) {
    return () => undefined;
  }
  const control = element;
  setControlValue(control, property, read());
  const eventName = property === "checked" ? "change" : "input";
  const listener = (): void => {
    write(property === "checked" && control instanceof HTMLInputElement ? control.checked : control.value);
  };
  control.addEventListener(eventName, listener);
  return () => control.removeEventListener(eventName, listener);
};
