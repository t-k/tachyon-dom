import { err, ok, type Result } from "../result";

export type HydrationBoundaryError = {
  message: string;
};

export type LocatedHydrationBoundary = {
  id: string;
  start: Comment;
  end: Comment;
  element: Element;
};

export type HydrationBoundaryHandle = {
  hydrate: () => void;
  hydrated: () => boolean;
  dispose: () => void;
};

type HydrationCleanup = void | (() => void);

const escapeScriptJson = (value: string): string => value.replaceAll("<", "\\u003c").replaceAll("-->", "--\\>");

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll(`"`, "&quot;").replaceAll("<", "&lt;");

const markerText = (id: string, edge: "start" | "end"): string => `tachyon-hydrate:${id}:${edge}`;

const commentsIn = (root: ParentNode): Comment[] => {
  const ownerDocument = root instanceof Document ? root : (root.ownerDocument ?? document);
  const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Comment) {
      comments.push(current);
    }
    current = walker.nextNode();
  }
  return comments;
};

const nextElementBetween = (start: Comment, end: Comment): Element | undefined => {
  let current = start.nextSibling;
  while (current && current !== end) {
    if (current instanceof Element) {
      return current;
    }
    current = current.nextSibling;
  }
  return undefined;
};

export const locateHydrationBoundary = (
  root: ParentNode,
  id: string,
): Result<LocatedHydrationBoundary, HydrationBoundaryError> => {
  const comments = commentsIn(root);
  const start = comments.find((comment) => comment.data === markerText(id, "start"));
  const end = comments.find((comment) => comment.data === markerText(id, "end"));
  if (!start || !end) {
    return err({ message: `Missing hydrate boundary markers for ${id}.` });
  }
  const element = nextElementBetween(start, end);
  if (!element) {
    return err({ message: `Missing hydrate boundary element for ${id}.` });
  }
  return ok({ id, start, end, element });
};

export const createHydrationBoundary = (
  root: ParentNode,
  id: string,
  bind: (element: Element) => HydrationCleanup,
): Result<HydrationBoundaryHandle, HydrationBoundaryError> => {
  const located = locateHydrationBoundary(root, id);
  if (!located.ok) {
    return err(located.error);
  }
  let cleanup: HydrationCleanup;
  let isHydrated = false;
  const hydrate = (): void => {
    if (isHydrated) {
      return;
    }
    cleanup = bind(located.value.element);
    isHydrated = true;
  };
  return ok({
    hydrate,
    hydrated: () => isHydrated,
    dispose: () => {
      if (typeof cleanup === "function") {
        cleanup();
      }
      isHydrated = false;
    },
  });
};

export const serializeHydrationState = (id: string, state: unknown): string =>
  `<script type="application/json" data-tachyon-state="${escapeAttribute(id)}">${escapeScriptJson(JSON.stringify(state))}</script>`;

export const readHydrationState = <T>(root: ParentNode, id: string): Result<T, HydrationBoundaryError> => {
  const script = Array.from(root.querySelectorAll(`script[type="application/json"][data-tachyon-state]`)).find(
    (candidate) => candidate.getAttribute("data-tachyon-state") === id,
  );
  if (!script) {
    return err({ message: `Missing hydration state for ${id}.` });
  }
  try {
    return ok(JSON.parse(script.textContent ?? "null") as T);
  } catch {
    return err({ message: `Invalid hydration state for ${id}.` });
  }
};
