import { err, ok, type Result } from "../result.js";
import { runCleanups } from "./subtree.js";

export type HydrationBoundaryErrorKind = "missing" | "duplicate" | "malformed";

export type HydrationBoundaryError = {
  message: string;
  /** Machine readable classification of a boundary adoption failure. */
  kind?: HydrationBoundaryErrorKind;
};

export type LocatedHydrationBoundary = {
  id: string;
  start: Comment;
  end: Comment;
  element: Element;
};

export type HydrationBoundaryDiagnostic = {
  id: string;
  type: "missing-start" | "missing-end" | "duplicate" | "missing-element" | "malformed";
  message: string;
};

export type HydrationDiagnosticsHot = {
  send: (event: string, payload: { err: { message: string; stack?: string } }) => void;
};

export type HydrationBoundaryHandle = {
  hydrate: () => void | Promise<void>;
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
  replayInteraction?: boolean;
  onError?: (error: HydrationBoundaryError) => void;
};

export type HydrationCleanup = void | (() => void);

export type HydrationBoundaryChunk =
  | ((element: Element, scope?: Record<string, unknown>) => HydrationCleanup)
  | { bind: (element: Element, scope?: Record<string, unknown>) => HydrationCleanup }
  | {
      default:
        | ((element: Element, scope?: Record<string, unknown>) => HydrationCleanup)
        | { bind: (element: Element, scope?: Record<string, unknown>) => HydrationCleanup };
    };

export type CompiledHydrationBoundary = {
  id: string;
  idKind?: "expression" | "static";
  /** Reads an expression id from the scope; generated descriptors carry it, hand-written ones fall back to a path. */
  idRead?: (scope: Record<string, unknown>) => unknown;
  path?: readonly number[];
  strategy?: HydrationStrategy;
  media?: string;
  interaction?: keyof HTMLElementEventMap | string;
  rootMargin?: string;
};

export type ScheduleHydrationBoundariesOptions = {
  resolveId?: (boundary: CompiledHydrationBoundary) => string | undefined;
  onError?: (error: HydrationBoundaryError, boundary: CompiledHydrationBoundary) => void;
  matchMedia?: (query: string) => MediaQueryList;
  replayInteraction?: boolean;
};

type HydrationCommentIndex = {
  starts: Map<string, Comment[]>;
  ends: Map<string, Comment[]>;
};

const escapeScriptJson = (value: string): string => value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll(`"`, "&quot;").replaceAll("<", "&lt;");

const hydrationCommentIndex = (root: ParentNode): HydrationCommentIndex => {
  const ownerDocument = root instanceof Document ? root : (root.ownerDocument ?? document);
  const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const starts = new Map<string, Comment[]>();
  const ends = new Map<string, Comment[]>();
  const prefix = "tachyon-hydrate:";
  for (let comment = walker.nextNode(); comment; comment = walker.nextNode()) {
    if (!(comment instanceof Comment) || !comment.data.startsWith(prefix)) continue;
    const suffix = comment.data.endsWith(":start") ? ":start" : comment.data.endsWith(":end") ? ":end" : undefined;
    if (suffix === undefined) continue;
    const id = comment.data.slice(prefix.length, -suffix.length);
    const markers = suffix === ":start" ? starts : ends;
    const bucket = markers.get(id);
    if (bucket) bucket.push(comment);
    else markers.set(id, [comment]);
  }
  return { starts, ends };
};

type BoundaryPairIssue = "malformed" | "missing-element";

const findBoundaryElement = (start: Comment, end: Comment): Element | BoundaryPairIssue => {
  if (
    start.parentNode === null ||
    start.parentNode !== end.parentNode ||
    !(start.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING)
  ) {
    return "malformed";
  }
  for (let current = start.nextSibling; current && current !== end; current = current.nextSibling) {
    if (current instanceof Element) return current;
  }
  return "missing-element";
};

const boundaryPairMessage = (id: string, issue: BoundaryPairIssue): string =>
  issue === "malformed"
    ? `Malformed hydrate boundary markers for ${id}.`
    : `Missing hydrate boundary element for ${id}.`;

export const locateHydrationBoundary = (
  root: ParentNode,
  id: string,
  index: HydrationCommentIndex = hydrationCommentIndex(root),
): Result<LocatedHydrationBoundary, HydrationBoundaryError> => {
  const starts = index.starts.get(id) ?? [];
  const ends = index.ends.get(id) ?? [];
  if (starts.length > 1 || ends.length > 1) {
    return err({ kind: "duplicate", message: `Duplicate hydrate boundary markers for ${id}.` });
  }
  const start = starts[0];
  const end = ends[0];
  if (!start || !end) {
    return err({ kind: "missing", message: `Missing hydrate boundary markers for ${id}.` });
  }
  const element = findBoundaryElement(start, end);
  if (typeof element === "string") {
    return err({ kind: "malformed", message: boundaryPairMessage(id, element) });
  }
  return ok({ id, start, end, element });
};

export const diagnoseHydrationBoundaries = (
  root: ParentNode,
  expectedIds: readonly string[],
): HydrationBoundaryDiagnostic[] => {
  const diagnostics: HydrationBoundaryDiagnostic[] = [];
  if (expectedIds.length === 0) return diagnostics;
  const index = hydrationCommentIndex(root);
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
    const start = starts[0];
    const end = ends[0];
    if (starts.length === 1 && ends.length === 1 && start && end) {
      const element = findBoundaryElement(start, end);
      if (typeof element === "string") {
        diagnostics.push({ id, type: element, message: boundaryPairMessage(id, element) });
      }
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

const replayedInteractions = new WeakSet<Event>();

/**
 * Returns true when the event is the replayed clone of an interaction that
 * triggered hydration. Capture listeners registered on ancestors such as
 * `document` observe both the original interaction and the replay, so they
 * can use this predicate to avoid duplicating side effects.
 */
export const isReplayedInteraction = (event: Event): boolean => replayedInteractions.has(event);

const cloneInteractionEvent = (event: Event): Event => {
  const clone =
    typeof MouseEvent !== "undefined" && event instanceof MouseEvent
      ? new MouseEvent(event.type, event)
      : typeof KeyboardEvent !== "undefined" && event instanceof KeyboardEvent
        ? new KeyboardEvent(event.type, event)
        : new Event(event.type, {
            bubbles: event.bubbles,
            cancelable: event.cancelable,
            composed: event.composed,
          });
  replayedInteractions.add(clone);
  return clone;
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
    const nextCleanup = bind(located.value.element);
    cleanup = nextCleanup;
    isHydrated = true;
  };
  return ok({
    hydrate,
    hydrated: () => isHydrated,
    element: () => located.value.element,
    dispose: () => {
      const currentCleanup = cleanup;
      cleanup = undefined;
      isHydrated = false;
      if (typeof currentCleanup === "function") currentCleanup();
    },
  });
};

const hydrationChunkBinder = (chunk: HydrationBoundaryChunk): ((element: Element) => HydrationCleanup) => {
  if (typeof chunk === "function") return chunk;
  if ("bind" in chunk) return chunk.bind;
  return typeof chunk.default === "function" ? chunk.default : chunk.default.bind;
};

const hydrationErrorFor = (error: unknown): HydrationBoundaryError => ({
  message: error instanceof Error ? error.message : String(error),
});

export const createLazyHydrationBoundary = (
  root: ParentNode,
  id: string,
  load: () => Promise<HydrationBoundaryChunk> | HydrationBoundaryChunk,
  options: { onError?: (error: HydrationBoundaryError) => void } = {},
  index?: HydrationCommentIndex,
): Result<HydrationBoundaryHandle, HydrationBoundaryError> => {
  const located = locateHydrationBoundary(root, id, index);
  if (!located.ok) return err(located.error);
  let cleanup: HydrationCleanup;
  let isHydrated = false;
  let loadedBinder: ((element: Element) => HydrationCleanup) | undefined;
  let pending: Promise<void> | undefined;
  let epoch = 0;
  const hydrate = (): Promise<void> => {
    if (isHydrated) return Promise.resolve();
    if (pending) return pending;
    const requestEpoch = epoch;
    let loadedChunk: Promise<HydrationBoundaryChunk>;
    try {
      loadedChunk = Promise.resolve(loadedBinder ? loadedBinder : load());
    } catch (error) {
      loadedChunk = Promise.reject(error);
    }
    let operation: Promise<void>;
    operation = loadedChunk
      .then((chunk) => {
        const binder = loadedBinder ?? hydrationChunkBinder(chunk as HydrationBoundaryChunk);
        loadedBinder = binder;
        if (requestEpoch !== epoch || isHydrated) return;
        cleanup = binder(located.value.element);
        isHydrated = true;
      })
      .catch((error: unknown) => {
        const hydrationError = hydrationErrorFor(error);
        options.onError?.(hydrationError);
        throw error;
      })
      .finally(() => {
        if (pending === operation) pending = undefined;
      });
    pending = operation;
    return operation;
  };
  return ok({
    hydrate,
    hydrated: () => isHydrated,
    element: () => located.value.element,
    dispose: () => {
      epoch += 1;
      const currentCleanup = cleanup;
      cleanup = undefined;
      isHydrated = false;
      if (typeof currentCleanup === "function") currentCleanup();
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
  const scheduler = { active: true };
  // `retry` re-arms the interaction trigger when hydration fails, so a failed
  // chunk load does not leave the boundary permanently unresponsive.
  // `replay` is decided once per event: only cancelable interactions are
  // suppressed and replayed. Non-cancelable events keep propagating untouched
  // and never produce a clone.
  const trigger = (event?: Event, retry?: () => void, replay = false): void => {
    const fail = (error: unknown): void => {
      retry?.();
      options.onError?.(hydrationErrorFor(error));
    };
    try {
      const hydration = handle.hydrate();
      if (replay && event) {
        const replay = (): void => {
          if (scheduler.active && handle.hydrated()) {
            const target =
              event.target instanceof Node && handle.element().contains(event.target) ? event.target : handle.element();
            target.dispatchEvent(cloneInteractionEvent(event));
          }
        };
        if (hydration && typeof hydration.then === "function") {
          void hydration.then(replay).catch(fail);
        } else {
          replay();
        }
      } else if (hydration && typeof hydration.then === "function") {
        void hydration.catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  };
  if (options.strategy === "load") {
    trigger();
    return () => undefined;
  }
  if (options.strategy === "idle") {
    const requestIdle =
      globalThis.requestIdleCallback ??
      ((callback: IdleRequestCallback) => setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0));
    const cancelIdle = globalThis.cancelIdleCallback ?? clearTimeout;
    let active = true;
    const id = requestIdle(() => {
      if (active) trigger();
    });
    return () => {
      active = false;
      cancelIdle(id);
    };
  }
  if (options.strategy === "media") {
    const query = options.media;
    if (!query) {
      return () => undefined;
    }
    const matcher = options.matchMedia ?? globalThis.matchMedia;
    const media = matcher(query);
    let active = true;
    const listener = (): void => {
      if (active && media.matches) {
        trigger();
      }
    };
    media.addEventListener("change", listener);
    listener();
    return () => {
      active = false;
      media.removeEventListener("change", listener);
    };
  }
  if (options.strategy === "visible") {
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (active && entries.some((entry) => entry.isIntersecting)) {
          trigger();
          observer.disconnect();
        }
      },
      options.rootMargin === undefined ? {} : { rootMargin: options.rootMargin },
    );
    observer.observe(handle.element());
    return () => {
      active = false;
      observer.disconnect();
    };
  }
  const eventName = options.interaction ?? "click";
  const element = handle.element();
  const listener = (event: Event): void => {
    if (!scheduler.active) return;
    element.removeEventListener(eventName, listener, true);
    const shouldReplay = options.replayInteraction === true && event.cancelable;
    if (shouldReplay) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    trigger(
      event,
      () => {
        if (scheduler.active) element.addEventListener(eventName, listener, true);
      },
      shouldReplay,
    );
  };
  element.addEventListener(eventName, listener, true);
  return () => {
    scheduler.active = false;
    element.removeEventListener(eventName, listener, true);
  };
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
        replayInteraction: options.replayInteraction ?? boundary.strategy === "interaction",
      }),
    );
    cleanups.push(() => handle.value.dispose());
  }
  return () => runCleanups(cleanups);
};
