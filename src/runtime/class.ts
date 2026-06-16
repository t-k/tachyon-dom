export const setClassPresence = (element: Element, className: string, value: unknown): void => {
  element.classList.toggle(className, Boolean(value));
};
