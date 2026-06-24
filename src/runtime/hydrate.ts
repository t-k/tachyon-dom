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

export type HydrationBoundaryDiagnostic = {
  id: string;
  type: "missing-start" | "missing-end" | "duplicate" | "missing-element";
  message: string;
};

export type HydrationBoundaryHandle = {
  hydrate: () => void;
  hydrated: () => boolean;
  element: () => Element;
  dispose: () => void;
};

export type HydrationStrategy = "load" | "idle" | "visible" | "media" | "interaction";

export type HydrationScheduleOptions = {
  strategy: HydrationStrategy;
  media?: string;
  interaction?: keyof HTMLElementEventMap | string;
  rootMargin?: string;
  matchMedia?: (query: string) => MediaQueryList;
};

export type CompiledHydrationBoundary = {
  id: string;
  idKind?: "expression" | "static";
  strategy?: HydrationStrategy;
  media?: string;
  interaction?: keyof HTMLElementEventMap | string;
  rootMargin?: string;
};

export type ScheduleHydrationBoundariesOptions = {
  resolveId?: (boundary: CompiledHydrationBoundary) => string | undefined;
  onError?: (error: HydrationBoundaryError, boundary: CompiledHydrationBoundary) => void;
  matchMedia?: (query: string) => MediaQueryList;
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

export const diagnoseHydrationBoundaries = (
  root: ParentNode,
  expectedIds: readonly string[],
): HydrationBoundaryDiagnostic[] => {
  const comments = commentsIn(root);
  const diagnostics: HydrationBoundaryDiagnostic[] = [];
  for (const id of expectedIds) {
    const starts = comments.filter((comment) => comment.data === markerText(id, "start"));
    const ends = comments.filter((comment) => comment.data === markerText(id, "end"));
    if (starts.length === 0) {
      diagnostics.push({ id, type: "missing-start", message: `Missing hydrate boundary start marker for ${id}.` });
    }
    if (ends.length === 0) {
      diagnostics.push({ id, type: "missing-end", message: `Missing hydrate boundary end marker for ${id}.` });
    }
    if (starts.length > 1 || ends.length > 1) {
      diagnostics.push({ id, type: "duplicate", message: `Duplicate hydrate boundary markers for ${id}.` });
    }
    if (starts.length === 1 && ends.length === 1 && !nextElementBetween(starts[0] as Comment, ends[0] as Comment)) {
      diagnostics.push({ id, type: "missing-element", message: `Missing hydrate boundary element for ${id}.` });
    }
  }
  return diagnostics;
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
    element: () => located.value.element,
    dispose: () => {
      if (typeof cleanup === "function") {
        cleanup();
      }
      isHydrated = false;
    },
  });
};

export const serializeHydrationState = (id: string, state: unknown, options: { nonce?: string } = {}): string => {
  const nonce = options.nonce ? ` nonce="${escapeAttribute(options.nonce)}"` : "";
  return `<script type="application/json" data-tachyon-state="${escapeAttribute(id)}"${nonce}>${escapeScriptJson(JSON.stringify(state))}</script>`;
};

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

export const scheduleHydration = (
  handle: HydrationBoundaryHandle,
  options: HydrationScheduleOptions = { strategy: "load" },
): (() => void) => {
  if (options.strategy === "load") {
    handle.hydrate();
    return () => undefined;
  }
  if (options.strategy === "idle") {
    const requestIdle =
      globalThis.requestIdleCallback ??
      ((callback: IdleRequestCallback) => setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0));
    const cancelIdle = globalThis.cancelIdleCallback ?? clearTimeout;
    const id = requestIdle(() => handle.hydrate());
    return () => cancelIdle(id);
  }
  if (options.strategy === "media") {
    const query = options.media;
    if (!query) {
      return () => undefined;
    }
    const matcher = options.matchMedia ?? globalThis.matchMedia;
    const media = matcher(query);
    const listener = (): void => {
      if (media.matches) {
        handle.hydrate();
      }
    };
    media.addEventListener("change", listener);
    listener();
    return () => media.removeEventListener("change", listener);
  }
  if (options.strategy === "visible") {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          handle.hydrate();
          observer.disconnect();
        }
      },
      options.rootMargin === undefined ? {} : { rootMargin: options.rootMargin },
    );
    observer.observe(handle.element());
    return () => observer.disconnect();
  }
  const eventName = options.interaction ?? "click";
  const listener = (): void => {
    handle.hydrate();
    document.removeEventListener(eventName, listener, true);
  };
  document.addEventListener(eventName, listener, true);
  return () => document.removeEventListener(eventName, listener, true);
};

export const scheduleHydrationBoundaries = (
  root: ParentNode,
  boundaries: readonly CompiledHydrationBoundary[],
  bind: (element: Element, boundary: CompiledHydrationBoundary) => HydrationCleanup,
  options: ScheduleHydrationBoundariesOptions = {},
): (() => void) => {
  const cleanups: Array<() => void> = [];
  for (const boundary of boundaries) {
    const id = boundary.idKind === "expression" ? options.resolveId?.(boundary) : boundary.id;
    if (!id) {
      continue;
    }
    const handle = createHydrationBoundary(root, id, (element) => bind(element, boundary));
    if (!handle.ok) {
      options.onError?.(handle.error, boundary);
      continue;
    }
    cleanups.push(
      scheduleHydration(handle.value, {
        strategy: boundary.strategy ?? "load",
        ...(boundary.media ? { media: boundary.media } : {}),
        ...(boundary.interaction ? { interaction: boundary.interaction } : {}),
        ...(boundary.rootMargin ? { rootMargin: boundary.rootMargin } : {}),
        ...(options.matchMedia ? { matchMedia: options.matchMedia } : {}),
      }),
    );
    cleanups.push(() => handle.value.dispose());
  }
  return () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
  };
};
