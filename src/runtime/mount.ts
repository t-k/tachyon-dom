import {
  isConditionalEndMarker,
  isConditionalStartMarker,
  isListEndMarker,
  isListStartMarker,
} from "../conditional-marker.js";
import { err, ok, type Result } from "../result.js";
import { diagnoseHydrationBoundaries, type CompiledHydrationBoundary, type HydrationBoundaryChunk } from "./hydrate.js";
import { createRoot, onCleanup } from "./signal.js";

export type ClientHydrationDynamicAttribute = {
  path: readonly number[];
  name: string;
  kind?: "value" | "token";
};

export type ClientHydrationDynamicRegion = {
  path: readonly number[];
  index: number;
  kind: "list" | "conditional";
};

type ClientHydrationDynamicRegions = readonly ClientHydrationDynamicRegion[] & {
  readonly errors?: readonly string[];
};

export type ClientTemplateModule<Scope extends Record<string, unknown> = Record<string, unknown>> = {
  templateHtml: string;
  /** Set by a module generated with `?client&mount-only`: it carries no hydration metadata. */
  mountOnly?: true;
  hydrationBoundaries?: readonly CompiledHydrationBoundary[];
  hydrationChunks?: Readonly<Record<string, () => Promise<HydrationBoundaryChunk> | HydrationBoundaryChunk>>;
  hydrationDynamicAttributes?: readonly ClientHydrationDynamicAttribute[];
  hydrationDynamicRegions?: ClientHydrationDynamicRegions;
  hydrationDynamicRegionErrors?: readonly string[];
  hydrate?: (bindRoot: Element, hydrationRoot: ParentNode, scope: Scope) => void | (() => void);
  bind: (root: Element, scope: Scope) => void | (() => void);
};

/**
 * A module generated with `?client&hydrate-only`: it hydrates SSR output and
 * never exposes `bind`, so it cannot be mounted into an empty root.
 */
export type HydrateOnlyTemplateModule<Scope extends Record<string, unknown> = Record<string, unknown>> = Omit<
  ClientTemplateModule<Scope>,
  "bind" | "hydrate"
> & {
  hydrateOnly: true;
  hydrate: (bindRoot: Element, hydrationRoot: ParentNode, scope: Scope) => void | (() => void);
};

export type HydratableTemplateModule<Scope extends Record<string, unknown> = Record<string, unknown>> =
  | ClientTemplateModule<Scope>
  | HydrateOnlyTemplateModule<Scope>;

export type MountHandle = {
  root: Element;
  disposed: () => boolean;
  dispose: () => void;
};

export type HydrateError = {
  message: string;
  diagnostics?: ReturnType<typeof diagnoseHydrationBoundaries>;
};

type OwnedCleanup = {
  dispose: () => void;
  disposed: () => boolean;
};

/**
 * Runs `bind` inside its own reactive root and registers the returned cleanup
 * with that root, so disposing the enclosing owner runs the binding cleanup
 * exactly once, just like an explicit `dispose()`.
 */
const ownCleanup = (bind: () => void | (() => void)): OwnedCleanup => {
  let isDisposed = false;
  const dispose = createRoot((disposeRoot) => {
    const cleanup = bind();
    onCleanup(() => {
      isDisposed = true;
      cleanup?.();
    });
    return disposeRoot;
  });
  return { dispose, disposed: () => isDisposed };
};

const handleFor = (root: Element, owned: OwnedCleanup): MountHandle => ({
  root,
  disposed: owned.disposed,
  dispose: owned.dispose,
});

const bindWithOwner = <Scope extends Record<string, unknown>>(
  root: Element,
  module: ClientTemplateModule<Scope>,
  scope: Scope,
): OwnedCleanup => ownCleanup(() => module.bind(root, scope));

const templateRootFor = (templateHtml: string): Element | undefined => {
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  return template.content.firstElementChild ?? undefined;
};

const tagNameFor = (element: Element): string => element.tagName.toLowerCase();

const hydrationChildNodes = (node: Node): Node[] =>
  Array.from(node.childNodes).filter(
    (child) =>
      child.nodeType !== Node.COMMENT_NODE ||
      child.nodeValue === "td:text" ||
      isConditionalStartMarker(child) ||
      isConditionalEndMarker(child) ||
      isListStartMarker(child) ||
      isListEndMarker(child),
  );

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

type RegionKind = "conditional" | "list";

const regionMarkers = {
  conditional: { isStart: isConditionalStartMarker, isEnd: isConditionalEndMarker },
  list: { isStart: isListStartMarker, isEnd: isListEndMarker },
} as const;

/**
 * Walks a server-rendered dynamic region: the start marker at (or, where earlier extra children are allowed,
 * after) `actualIndex`, its content, and the matching end marker. Returns the index after the end marker, or
 * the mismatch. Nested regions of either kind close their own markers, so a branch or row can hold further
 * `<if>`s and `<for>`s; the content itself is server output the region's runtime adopts, so only nodes that
 * would be unsafe to leave in place are rejected here.
 */
const hydrationRegionEnd = (
  kind: RegionKind,
  actualChildren: readonly Node[],
  actualIndex: number,
  path: readonly number[],
  expectedIndex: number,
  allowsExtraChildren: boolean,
): number | string => {
  const label = hydrationPathLabel(path);
  const { isStart, isEnd } = regionMarkers[kind];
  let index = actualIndex;
  while (index < actualChildren.length && !isStart(actualChildren[index] as Node)) {
    if (!allowsExtraChildren) {
      return `Hydration structure mismatch at ${label}: expected a ${kind} region at child ${expectedIndex}.`;
    }
    const unsafeError = hydrationUnsafeExtraNodeError(actualChildren[index] as Node, [...path, index]);
    if (unsafeError) return unsafeError;
    index++;
  }
  if (index >= actualChildren.length) {
    return `Hydration structure mismatch at ${label}: missing child ${expectedIndex}.`;
  }
  let depth = 0;
  for (index++; index < actualChildren.length; index++) {
    const node = actualChildren[index] as Node;
    if (isStart(node)) {
      depth++;
    } else if (isEnd(node)) {
      if (depth === 0) return index + 1;
      depth--;
    } else {
      const unsafeError = hydrationUnsafeExtraNodeError(node, [...path, index]);
      if (unsafeError) return unsafeError;
    }
  }
  return `Hydration structure mismatch at ${label}: unterminated ${kind} region at child ${expectedIndex}.`;
};

const hydrationStructureError = (
  expected: Node,
  actual: Node,
  path: readonly number[],
  dynamicAttributes: ReadonlyMap<string, ClientHydrationDynamicAttribute>,
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
      const dynamicAttribute = dynamicAttributes.get(hydrationAttributeKey(path, attribute.name));
      if (dynamicAttribute?.kind === "token" && attribute.name.toLowerCase() === "class") {
        const actualTokens = new Set((actualElement.getAttribute(attribute.name) ?? "").split(/\s+/).filter(Boolean));
        const expectedTokens = attribute.value.split(/\s+/).filter(Boolean);
        if (expectedTokens.some((token) => !actualTokens.has(token))) {
          return `Hydration structure mismatch at ${label}: attribute ${attribute.name} does not match.`;
        }
      } else if (actualElement.getAttribute(attribute.name) !== attribute.value) {
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
    // Region end markers and list markers occupy no logical slot, so the logical index (the one paths use) can
    // trail the template child index.
    let logicalIndex = -1;
    for (let expectedIndex = 0; expectedIndex < expectedChildren.length; expectedIndex++) {
      const expectedChild = expectedChildren[expectedIndex] as Node;
      if (isConditionalEndMarker(expectedChild) || isListEndMarker(expectedChild)) continue;
      if (isListStartMarker(expectedChild)) {
        const regionEnd = hydrationRegionEnd("list", actualChildren, actualIndex, path, logicalIndex + 1, false);
        if (typeof regionEnd === "string") return regionEnd;
        actualIndex = regionEnd;
        continue;
      }
      logicalIndex++;
      if (isConditionalStartMarker(expectedChild)) {
        const regionEnd = hydrationRegionEnd(
          "conditional",
          actualChildren,
          actualIndex,
          path,
          logicalIndex,
          allowsExtraChildren,
        );
        if (typeof regionEnd === "string") return regionEnd;
        actualIndex = regionEnd;
        continue;
      }
      if (expectedChild.nodeType === Node.COMMENT_NODE) {
        allowsExtraChildren = true;
        continue;
      }
      const actualChild = actualChildren[actualIndex];
      if (!actualChild) {
        return `Hydration structure mismatch at ${label}: missing child ${logicalIndex}.`;
      }
      const childPath = [...path, logicalIndex];
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
    if (!allowsExtraChildren && actualIndex < actualChildren.length) {
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

/** Roots with a live hydration handle; a second hydrate must not bind twice. */
const hydratedRoots = new WeakSet<Element>();

export const mount = <Scope extends Record<string, unknown>>(
  root: Element,
  module: ClientTemplateModule<Scope>,
  scope?: Scope,
): MountHandle => {
  if (typeof (module as { bind?: unknown }).bind !== "function") {
    throw new TypeError("Cannot mount a hydrate-only client module; use hydrate() on server-rendered markup instead.");
  }
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
  module: HydratableTemplateModule<Scope>,
  scope?: Scope,
): Result<MountHandle, HydrateError> => {
  // Checked before anything reads or replaces the server DOM.
  if ((module as { mountOnly?: unknown }).mountOnly === true) {
    return err({
      message: "Cannot hydrate a mount-only client module; generate it without mount-only to hydrate server output.",
    });
  }
  if (hydratedRoots.has(root)) {
    return err({ message: "Hydration root is already hydrated; dispose the previous handle first." });
  }
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
  const dynamicAttributes = new Map(
    (module.hydrationDynamicAttributes ?? []).map((attribute) => [
      hydrationAttributeKey(attribute.path, attribute.name),
      attribute,
    ]),
  );
  const dynamicRegionDiagnostic =
    module.hydrationDynamicRegionErrors?.[0] ?? module.hydrationDynamicRegions?.errors?.[0];
  if (dynamicRegionDiagnostic) {
    return err({ message: dynamicRegionDiagnostic });
  }
  const structureError = hydrationStructureError(expectedRoot, bindRoot, [], dynamicAttributes);
  if (structureError) {
    return err({ message: structureError });
  }
  try {
    const owned = ownCleanup(() => {
      hydratedRoots.add(root);
      const cleanup = module.hydrate
        ? module.hydrate(bindRoot, root, scope as Scope)
        : (module as ClientTemplateModule<Scope>).bind(bindRoot, scope as Scope);
      return () => {
        hydratedRoots.delete(root);
        cleanup?.();
      };
    });
    return ok(handleFor(root, owned));
  } catch (error) {
    hydratedRoots.delete(root);
    return err({ message: error instanceof Error ? error.message : String(error) });
  }
};

export const mountClientTemplate = mount;
export const hydrateClientTemplate = hydrate;
