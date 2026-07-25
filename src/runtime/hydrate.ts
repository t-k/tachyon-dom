import { err, ok, type Result } from "../result.js";

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

export type HydrationDiagnosticsHot = {
  send: (event: string, payload: { err: { message: string; stack?: string } }) => void;
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

type HydrationCommentIndex = {
  starts: Map<string, Comment[]>;
  ends: Map<string, Comment[]>;
};

const escapeScriptJson = (value: string): string => value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll(`"`, "&quot;").replaceAll("<", "&lt;");

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

const hydrationCommentIndex = (root: ParentNode): HydrationCommentIndex => {
  const starts = new Map<string, Comment[]>();
  const ends = new Map<string, Comment[]>();
  for (const comment of commentsIn(root)) {
    if (!comment.data.startsWith("tachyon-hydrate:")) {
      continue;
    }
    if (comment.data.endsWith(":start")) {
      const id = comment.data.slice("tachyon-hydrate:".length, -":start".length);
      starts.set(id, [...(starts.get(id) ?? []), comment]);
    } else if (comment.data.endsWith(":end")) {
      const id = comment.data.slice("tachyon-hydrate:".length, -":end".length);
      ends.set(id, [...(ends.get(id) ?? []), comment]);
    }
  }
  return { starts, ends };
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
  index: HydrationCommentIndex = hydrationCommentIndex(root),
): Result<LocatedHydrationBoundary, HydrationBoundaryError> => {
  const start = index.starts.get(id)?.[0];
  const end = index.ends.get(id)?.[0];
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
  const index = hydrationCommentIndex(root);
  const diagnostics: HydrationBoundaryDiagnostic[] = [];
  for (const id of expectedIds) {
    const starts = index.starts.get(id) ?? [];
    const ends = index.ends.get(id) ?? [];
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

export const reportHydrationDiagnostics = (
  root: ParentNode,
  expectedIds: readonly string[],
  options: { hot?: HydrationDiagnosticsHot } = {},
): HydrationBoundaryDiagnostic[] => {
  const diagnostics = diagnoseHydrationBoundaries(root, expectedIds);
  for (const diagnostic of diagnostics) {
    options.hot?.send("vite:error", {
      err: {
        message: diagnostic.message,
        stack: diagnostic.message,
      },
    });
  }
  return diagnostics;
};

export const createHydrationBoundary = (
  root: ParentNode,
  id: string,
  bind: (element: Element) => HydrationCleanup,
  index?: HydrationCommentIndex,
): Result<HydrationBoundaryHandle, HydrationBoundaryError> => {
  const located = locateHydrationBoundary(root, id, index);
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
  return `<script type="application/json" data-tachyon-state="${escapeAttribute(id)}"${nonce}>${escapeScriptJson(JSON.stringify(state) ?? "null")}</script>`;
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
  const element = handle.element();
  const listener = (): void => {
    handle.hydrate();
    element.removeEventListener(eventName, listener, true);
  };
  element.addEventListener(eventName, listener, true);
  return () => element.removeEventListener(eventName, listener, true);
};

export const scheduleHydrationBoundaries = (
  root: ParentNode,
  boundaries: readonly CompiledHydrationBoundary[],
  bind: (element: Element, boundary: CompiledHydrationBoundary) => HydrationCleanup,
  options: ScheduleHydrationBoundariesOptions = {},
): (() => void) => {
  const cleanups: Array<() => void> = [];
  const index = hydrationCommentIndex(root);
  for (const boundary of boundaries) {
    const id = boundary.idKind === "expression" ? options.resolveId?.(boundary) : boundary.id;
    if (!id) {
      continue;
    }
    const handle = createHydrationBoundary(root, id, (element) => bind(element, boundary), index);
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
