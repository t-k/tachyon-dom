import { catchError } from "./signal.js";
import { isClientHtml, type ClientHtml } from "./html.js";

type ErrorBoundaryRenderValue = string | ClientHtml | Node | readonly Node[] | DocumentFragment;

export type ErrorBoundaryOptions = {
  render: (root: Element) => void;
  fallback: (error: unknown) => ErrorBoundaryRenderValue;
};

const renderValue = (root: Element, value: ErrorBoundaryRenderValue): void => {
  root.replaceChildren();
  if (typeof value === "string") {
    root.textContent = value;
    return;
  }
  if (isClientHtml(value)) {
    root.innerHTML = value.toString();
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
