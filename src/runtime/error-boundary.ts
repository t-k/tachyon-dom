import { catchError } from "./signal.js";

type ErrorBoundaryRenderValue = string | Node | readonly Node[] | DocumentFragment;

export type ErrorBoundaryOptions = {
  render: (root: Element) => void;
  fallback: (error: unknown) => ErrorBoundaryRenderValue;
};

const renderValue = (root: Element, value: ErrorBoundaryRenderValue): void => {
  root.replaceChildren();
  if (typeof value === "string") {
    root.innerHTML = value;
    return;
  }
  if (value instanceof DocumentFragment) {
    root.appendChild(value);
    return;
  }
  if (value instanceof Node) {
    root.appendChild(value);
    return;
  }
  root.append(...value);
};

export const createErrorBoundary = (root: Element, options: ErrorBoundaryOptions): (() => void) =>
  catchError(
    () => {
      options.render(root);
    },
    (error) => {
      renderValue(root, options.fallback(error));
    },
  );
