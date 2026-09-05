import { err, ok, type Result } from "../result.js";
import { diagnoseHydrationBoundaries, type CompiledHydrationBoundary } from "./hydrate.js";
import { createRoot } from "./signal.js";

export type ClientHydrationDynamicAttribute = {
  path: readonly number[];
  name: string;
};

export type ClientTemplateModule<Scope extends Record<string, unknown> = Record<string, unknown>> = {
  templateHtml: string;
  hydrationBoundaries?: readonly CompiledHydrationBoundary[];
  hydrationDynamicAttributes?: readonly ClientHydrationDynamicAttribute[];
  bind: (root: Element, scope: Scope) => void | (() => void);
};

export type MountHandle = {
  root: Element;
  disposed: () => boolean;
  dispose: () => void;
};

export type HydrateError = {
  message: string;
  diagnostics?: ReturnType<typeof diagnoseHydrationBoundaries>;
};

const handleFor = (root: Element, cleanup: void | (() => void)): MountHandle => {
  let isDisposed = false;
  return {
    root,
    disposed: () => isDisposed,
    dispose: () => {
      if (isDisposed) return;
      isDisposed = true;
      cleanup?.();
    },
  };
};

const bindWithOwner = <Scope extends Record<string, unknown>>(
  root: Element,
  module: ClientTemplateModule<Scope>,
  scope: Scope,
): (() => void) =>
  createRoot((disposeRoot) => {
    const bindCleanup = module.bind(root, scope);
    return () => {
      let firstError: unknown;
      let failed = false;
      try {
        bindCleanup?.();
      } catch (error) {
        firstError = error;
        failed = true;
      }
      try {
        disposeRoot();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
      if (failed) throw firstError;
    };
  });

const templateRootFor = (templateHtml: string): Element | undefined => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return template.content.firstElementChild ?? undefined;
};

const tagNameFor = (element: Element): string => element.tagName.toLowerCase();

const hydrationChildNodes = (node: Node): Node[] =>
  Array.from(node.childNodes).filter((child) => child.nodeType !== Node.COMMENT_NODE || child.nodeValue === "td:text");

const hydrationPathLabel = (path: readonly number[]): string => (path.length === 0 ? "root" : `root.${path.join(".")}`);

const hydrationAttributeKey = (path: readonly number[], name: string): string =>
  `${path.join(".")}\0${name.toLowerCase()}`;

const hydrationUnsafeExtraNodeError = (node: Node, path: readonly number[]): string | undefined => {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return undefined;
  }
  const element = node as Element;
  const label = hydrationPathLabel(path);
  if (tagNameFor(element) === "script") {
    return `Hydration structure mismatch at ${label}: found an unexpected <script> element.`;
  }
  const eventAttribute = Array.from(element.attributes).find((attribute) =>
    attribute.name.toLowerCase().startsWith("on"),
  );
  if (eventAttribute) {
    return `Hydration structure mismatch at ${label}: found an unexpected event attribute ${eventAttribute.name}.`;
  }
  for (const [index, child] of Array.from(element.childNodes).entries()) {
    const error = hydrationUnsafeExtraNodeError(child, [...path, index]);
    if (error) return error;
  }
  return undefined;
};

const hydrationStructureError = (
  expected: Node,
  actual: Node,
  path: readonly number[],
  dynamicAttributes: ReadonlySet<string>,
): string | undefined => {
  const label = hydrationPathLabel(path);
  if (expected.nodeType === Node.ELEMENT_NODE) {
    if (actual.nodeType !== Node.ELEMENT_NODE) {
      return `Hydration structure mismatch at ${label}: expected an element, found ${actual.nodeName}.`;
    }
    const expectedElement = expected as Element;
    const actualElement = actual as Element;
    if (tagNameFor(expectedElement) !== tagNameFor(actualElement)) {
      return `Hydration structure mismatch at ${label}: expected <${tagNameFor(expectedElement)}>, found <${tagNameFor(actualElement)}>.`;
    }
    for (const attribute of Array.from(expectedElement.attributes)) {
      if (actualElement.getAttribute(attribute.name) !== attribute.value) {
        return `Hydration structure mismatch at ${label}: attribute ${attribute.name} does not match.`;
      }
    }
    for (const attribute of Array.from(actualElement.attributes)) {
      if (
        !expectedElement.hasAttribute(attribute.name) &&
        !dynamicAttributes.has(hydrationAttributeKey(path, attribute.name))
      ) {
        return `Hydration structure mismatch at ${label}: found an unexpected attribute ${attribute.name}.`;
      }
    }
    const expectedChildren = Array.from(expected.childNodes);
    const actualChildren = hydrationChildNodes(actual);
    let actualIndex = 0;
    let allowsExtraChildren = false;
    for (let expectedIndex = 0; expectedIndex < expectedChildren.length; expectedIndex++) {
      const expectedChild = expectedChildren[expectedIndex] as Node;
      if (expectedChild.nodeType === Node.COMMENT_NODE) {
        allowsExtraChildren = true;
        continue;
      }
      const actualChild = actualChildren[actualIndex];
      if (!actualChild) {
        return `Hydration structure mismatch at ${label}: missing child ${expectedIndex}.`;
      }
      const childPath = [...path, expectedIndex];
      if (allowsExtraChildren) {
        let matched = false;
        while (actualIndex < actualChildren.length) {
          const candidate = actualChildren[actualIndex] as Node;
          const candidateError = hydrationStructureError(expectedChild, candidate, childPath, dynamicAttributes);
          actualIndex++;
          if (!candidateError) {
            matched = true;
            break;
          }
          if (
            expectedChild.nodeType === Node.ELEMENT_NODE &&
            candidate.nodeType === Node.ELEMENT_NODE &&
            tagNameFor(expectedChild as Element) === tagNameFor(candidate as Element)
          ) {
            return candidateError;
          }
          const unsafeError = hydrationUnsafeExtraNodeError(candidate, [...path, actualIndex - 1]);
          if (unsafeError) return unsafeError;
        }
        if (!matched) {
          return `Hydration structure mismatch at ${hydrationPathLabel(childPath)}: expected a matching child.`;
        }
        continue;
      }
      const mismatch = hydrationStructureError(expectedChild, actualChild, childPath, dynamicAttributes);
      if (mismatch) return mismatch;
      actualIndex++;
    }
    if (!allowsExtraChildren && actualIndex < actualChildren.length && expectedChildren.length > 0) {
      return `Hydration structure mismatch at ${label}: found an unexpected child.`;
    }
    if (allowsExtraChildren) {
      for (let index = actualIndex; index < actualChildren.length; index++) {
        const extraError = hydrationUnsafeExtraNodeError(actualChildren[index] as Node, [...path, index]);
        if (extraError) return extraError;
      }
    }
    return undefined;
  }
  if (expected.nodeType === Node.TEXT_NODE) {
    if (actual.nodeType === Node.TEXT_NODE) return undefined;
    if (expected.nodeValue === " " && actual.nodeType === Node.COMMENT_NODE && actual.nodeValue === "td:text") {
      return undefined;
    }
    return `Hydration structure mismatch at ${label}: expected a text node, found ${actual.nodeName}.`;
  }
  return undefined;
};

const hydrationRootFor = (root: Element, expectedRoot: Element): Element | undefined => {
  if (tagNameFor(root) === tagNameFor(expectedRoot)) return root;
  const children = Array.from(root.children);
  return children.length === 1 && tagNameFor(children[0] as Element) === tagNameFor(expectedRoot)
    ? (children[0] as Element)
    : undefined;
};

export const mount = <Scope extends Record<string, unknown>>(
  root: Element,
  module: ClientTemplateModule<Scope>,
  scope?: Scope,
): MountHandle => {
  const previousChildren = Array.from(root.childNodes);
  try {
    root.innerHTML = module.templateHtml;
    const bindRoot = root.firstElementChild;
    if (!bindRoot) {
      throw new Error("Client template must render an element root.");
    }
    return handleFor(root, bindWithOwner(bindRoot, module, scope as Scope));
  } catch (error) {
    root.replaceChildren(...previousChildren);
    throw error;
  }
};

export const hydrate = <Scope extends Record<string, unknown>>(
  root: Element,
  module: ClientTemplateModule<Scope>,
  scope?: Scope,
): Result<MountHandle, HydrateError> => {
  const ids = (module.hydrationBoundaries ?? [])
    .filter((boundary) => boundary.idKind !== "expression")
    .map((boundary) => boundary.id);
  const diagnostics = diagnoseHydrationBoundaries(root, ids);
  if (diagnostics.length > 0) {
    return err({
      message: diagnostics.map((diagnostic) => diagnostic.message).join(" "),
      diagnostics,
    });
  }
  const expectedRoot = templateRootFor(module.templateHtml);
  const bindRoot = expectedRoot ? hydrationRootFor(root, expectedRoot) : undefined;
  if (!expectedRoot || !bindRoot) {
    return err({
      message: `Hydration structure mismatch: expected <${expectedRoot ? tagNameFor(expectedRoot) : "element"}>.`,
    });
  }
  const dynamicAttributes = new Set(
    (module.hydrationDynamicAttributes ?? []).map((attribute) => hydrationAttributeKey(attribute.path, attribute.name)),
  );
  const structureError = hydrationStructureError(expectedRoot, bindRoot, [], dynamicAttributes);
  if (structureError) {
    return err({ message: structureError });
  }
  try {
    return ok(handleFor(root, bindWithOwner(bindRoot, module, scope as Scope)));
  } catch (error) {
    return err({ message: error instanceof Error ? error.message : String(error) });
  }
};

export const mountClientTemplate = mount;
export const hydrateClientTemplate = hydrate;
