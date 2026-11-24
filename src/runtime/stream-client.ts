import { clientShapedNodes, listRegionStartBetween, templateNodeAt } from "../conditional-marker.js";
import { err, ok, type Result } from "../result.js";
import { withListRegionStart } from "./list-core.js";
import { createRoot, read } from "./signal.js";
import { cleanupOwnedSubtree, registerOwnedSubtree } from "./subtree.js";

export const readTextStreamChunks = async (stream: ReadableStream<Uint8Array>): Promise<string[]> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      const trailing = decoder.decode();
      if (trailing) {
        chunks.push(trailing);
      }
      return chunks;
    }
    const chunk = decoder.decode(result.value, { stream: true });
    if (chunk) {
      chunks.push(chunk);
    }
  }
};

export type DeferredDataChunk = {
  id: string;
  key: string;
  value: unknown;
};

const escapeSelectorValue = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`);

export const applyDeferredDataChunk = (root: ParentNode, chunk: DeferredDataChunk): boolean => {
  const selector = `[data-tachyon-deferred-target="${escapeSelectorValue(`${chunk.id}:${chunk.key}`)}"]`;
  const target = root.querySelector(selector);
  if (!target) {
    return false;
  }
  target.textContent = typeof chunk.value === "string" ? chunk.value : JSON.stringify(chunk.value);
  return true;
};

export type DeferredDataReadError = { kind: "missing"; id: string } | { kind: "invalid"; id: string; cause: unknown };

export const readDeferredDataScriptResult = <T = unknown>(
  root: ParentNode,
  id: string,
): Result<T, DeferredDataReadError> => {
  const script = Array.from(root.querySelectorAll(`script[type="application/json"][data-tachyon-deferred]`)).find(
    (candidate) => candidate.getAttribute("data-tachyon-deferred") === id,
  );
  if (!script) {
    return err({ kind: "missing", id });
  }
  try {
    return ok(JSON.parse(script.textContent ?? "null") as T);
  } catch (cause) {
    return err({ kind: "invalid", id, cause });
  }
};

/** @deprecated Use readDeferredDataScriptResult to distinguish missing and invalid data. */
export const readDeferredDataScript = <T = unknown>(root: ParentNode, id: string): T | undefined => {
  const result = readDeferredDataScriptResult<T>(root, id);
  return result.ok ? result.value : undefined;
};

// --- Streaming <await> replacement & hydration runtime ---

export type AwaitSwapStatus = "resolved" | "error";

export type AwaitDirectListMounter = (index: number, mount: (container: Element) => void) => void;

export type AwaitRegionOptions = {
  id: string;
  thenName: string;
  pending?: string;
  error?: string;
  templateHtml: string;
  readValue: (scope: Record<string, unknown>) => unknown;
  bind: (
    nodes: readonly Node[],
    scope: Record<string, unknown>,
    adopted: boolean,
    mountDirectList: AwaitDirectListMounter,
  ) => void | (() => void);
};

type AwaitSwapHandler = (status: AwaitSwapStatus) => void;

type AwaitGlobalHost = typeof globalThis & {
  __tachyonAwaitHandlers?: Map<string, AwaitSwapHandler>;
};

const getAwaitHandlers = (): Map<string, AwaitSwapHandler> => {
  const host = globalThis as AwaitGlobalHost;
  return (host.__tachyonAwaitHandlers ??= new Map<string, AwaitSwapHandler>());
};

const awaitMarkerId = (anchor: Comment, fallbackId: string): string => {
  const value = anchor.nodeValue ?? "";
  return value.startsWith("tachyon-await:") ? value.slice("tachyon-await:".length) : fallbackId;
};

const awaitEndMarker = (start: Comment, id: string): Comment | undefined => {
  const startValue = `tachyon-await:${id}`;
  const endValue = `/${startValue}`;
  let depth = 0;
  for (let node = start.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType === Node.COMMENT_NODE) {
      if (node.nodeValue === startValue) depth++;
      else if (node.nodeValue === endValue) {
        if (depth === 0) return node as Comment;
        depth--;
      }
    }
  }
  return undefined;
};

const findPendingAwaitStart = (root: ParentNode, id: string): Comment | undefined => {
  const doc = root instanceof Document ? root : (root.ownerDocument ?? document);
  const targetValue = `tachyon-await:${id}`;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue === targetValue) {
      const next = node.nextSibling;
      if (next && next.nodeType === Node.COMMENT_NODE && next.nodeValue === "td:await:pending") {
        return node as Comment;
      }
    }
  }
  return undefined;
};

const clearBetween = (start: Comment, end: Comment): void => {
  while (start.nextSibling && start.nextSibling !== end) {
    start.nextSibling.remove();
  }
};

const insertHtmlBefore = (html: string, end: Comment): Node[] => {
  const doc = end.ownerDocument ?? document;
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  const nodes = Array.from(tpl.content.childNodes);
  end.parentNode?.insertBefore(tpl.content, end);
  return nodes;
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

/**
 * Applies any unexecuted `<template data-tachyon-await="...">` replacement chunks within `root`
 * (or the owning document). Only pending regions (`<!--td:await:pending-->`) are swapped so late
 * or duplicate chunks can never overwrite already-resolved or client-updated DOM. Runs in passes
 * so nested `<await>` templates apply right after their parent swaps in.
 */
export const applyPendingAwaitSwaps = (
  root: ParentNode = document,
  onlyId?: string,
  requireComplete = false,
): number => {
  const selector = onlyId
    ? `template[data-tachyon-await="${escapeSelectorValue(onlyId)}"]`
    : `template[data-tachyon-await]`;
  let totalSwapped = 0;
  while (true) {
    let passSwapped = 0;
    const templates = Array.from(root.querySelectorAll(selector));
    for (const template of templates) {
      const id = template.getAttribute("data-tachyon-await");
      if (!id) continue;
      const swapScript = root.querySelector(`script[data-tachyon-await="swap:${escapeSelectorValue(id)}"]`);
      if (requireComplete && !swapScript && template.nextSibling === null) continue;
      const start = findPendingAwaitStart(root, id);
      const end = start ? awaitEndMarker(start, id) : undefined;
      if (!start || !end || start.parentNode !== end.parentNode) continue;
      const status = (template.getAttribute("data-status") === "error" ? "error" : "resolved") as AwaitSwapStatus;
      clearBetween(start, end);
      end.parentNode?.insertBefore((template as HTMLTemplateElement).content, end);
      template.remove();
      swapScript?.remove();
      passSwapped++;
      totalSwapped++;
      const handlers = getAwaitHandlers();
      const handler = handlers.get(id);
      if (handler) {
        handlers.delete(id);
        handler(status);
      }
    }
    if (passSwapped === 0 || onlyId) break;
  }
  return totalSwapped;
};

type PendingObserverEntry = {
  observer: MutationObserver;
  count: number;
};

const pendingObservers = new WeakMap<ParentNode, PendingObserverEntry>();

const retainPendingObserver = (root: ParentNode): (() => void) => {
  if (typeof MutationObserver === "undefined") return () => undefined;
  let entry = pendingObservers.get(root);
  if (!entry) {
    const target = root instanceof Document ? (root.documentElement ?? root) : root;
    const observer = new MutationObserver(() => {
      applyPendingAwaitSwaps(root, undefined, true);
    });
    observer.observe(target, { childList: true, subtree: true });
    entry = { observer, count: 0 };
    pendingObservers.set(root, entry);
  }
  entry.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = pendingObservers.get(root);
    if (!current) return;
    current.count--;
    if (current.count <= 0) {
      current.observer.disconnect();
      pendingObservers.delete(root);
    }
  };
};

type AwaitState = {
  id: string;
  disposed: boolean;
  bound: boolean;
  generation: number;
  lastValue: unknown;
  scope: Record<string, unknown>;
  cleanup?: (() => void) | undefined;
  handler?: AwaitSwapHandler | undefined;
  releaseObserver?: (() => void) | undefined;
};

const awaitStates = new WeakMap<Comment, AwaitState>();

/** Resolves the `<await>` marker comment addressed by a template path. */
export const awaitAnchorAt = (root: Node, path: readonly number[]): Node | undefined => templateNodeAt(root, path);

/** Disposes an `<await>` region's bindings and cancels any pending swap/promise handlers. */
export const cleanupAwaitRegion = (anchor: Node | undefined): void => {
  if (!(anchor instanceof Comment)) return;
  const state = awaitStates.get(anchor);
  if (!state) return;
  state.disposed = true;
  state.generation++;
  awaitStates.delete(anchor);
  if (state.handler) {
    const handlers = getAwaitHandlers();
    if (handlers.get(state.id) === state.handler) handlers.delete(state.id);
    state.handler = undefined;
  }
  const releaseObserver = state.releaseObserver;
  state.releaseObserver = undefined;
  releaseObserver?.();
  const cleanup = state.cleanup;
  state.cleanup = undefined;
  cleanup?.();
};

const regionStatus = (start: Comment, end: Comment): "empty" | "pending" | "error" | "resolved" => {
  const first = start.nextSibling;
  if (!first || first === end) return "empty";
  if (first.nodeType === Node.COMMENT_NODE) {
    if (first.nodeValue === "td:await:pending") return "pending";
    if (first.nodeValue === "td:await:error") return "error";
  }
  return "resolved";
};

const createAwaitScope = (state: AwaitState, thenName: string, resolved: unknown): Record<string, unknown> =>
  new Proxy<Record<string, unknown>>(
    {},
    {
      get: (_target, prop) => (prop === thenName ? resolved : Reflect.get(state.scope, prop)),
      has: (_target, prop) => prop === thenName || prop in state.scope,
      set: (_target, prop, next) => (prop === thenName ? true : Reflect.set(state.scope, prop, next)),
      ownKeys: () => Array.from(new Set([...Reflect.ownKeys(state.scope), thenName])),
      getOwnPropertyDescriptor: (_target, prop) =>
        prop === thenName
          ? { value: resolved, enumerable: true, configurable: true, writable: false }
          : { value: Reflect.get(state.scope, prop), enumerable: true, configurable: true, writable: true },
    },
  );

/**
 * Mounts or hydrates an `<await>` region between `<!--tachyon-await:id-->` and `<!--/tachyon-await:id-->`.
 * Supports SSR already-resolved adoption, SSR in-flight pending wait + swap handoff, strict CSP template draining
 * (both before and after hydration), error settlement without binding the `then` branch, and client-only async mounting.
 */
export const mountAwaitRegion = (
  anchor: Node | undefined,
  options: AwaitRegionOptions,
  scope: Record<string, unknown>,
): void => {
  if (!(anchor instanceof Comment)) return;
  const runtimeId = awaitMarkerId(anchor, options.id);
  const end = awaitEndMarker(anchor, runtimeId);
  if (!end) return;

  const value = read(options.readValue(scope));
  const existing = awaitStates.get(anchor);
  if (existing && Object.is(existing.lastValue, value)) {
    existing.scope = scope;
    return;
  }
  if (existing) {
    cleanupAwaitRegion(anchor);
    clearBetween(anchor, end);
  }

  const state: AwaitState = {
    id: runtimeId,
    disposed: false,
    bound: false,
    generation: 0,
    lastValue: value,
    scope,
  };
  awaitStates.set(anchor, state);
  registerOwnedSubtree(anchor, () => cleanupAwaitRegion(anchor));

  const rootNode = anchor.getRootNode();
  const observableRoot =
    rootNode instanceof Document || rootNode instanceof Element || rootNode instanceof DocumentFragment
      ? rootNode
      : undefined;

  // Drain any unapplied streaming swap templates already in the owning root/document (strict CSP fallback).
  if (observableRoot) {
    applyPendingAwaitSwaps(observableRoot, runtimeId);
  }

  const mountDirectList: AwaitDirectListMounter = (index, mount) => {
    const parent = anchor.parentNode;
    const start = listRegionStartBetween(anchor.nextSibling, end, index);
    if (parent instanceof Element && start) {
      withListRegionStart(start, () => mount(parent));
    }
  };

  const bindInOwner = (nodes: readonly Node[], resolved: unknown, adopted: boolean): void => {
    const childScope = createAwaitScope(state, options.thenName, resolved);
    let innerCleanup: (() => void) | undefined;
    let rootDispose: (() => void) | undefined;
    try {
      createRoot((dispose) => {
        rootDispose = dispose;
        const cleanup = options.bind(nodes, childScope, adopted, mountDirectList);
        innerCleanup = typeof cleanup === "function" ? cleanup : undefined;
      });
    } catch (error) {
      try {
        innerCleanup?.();
      } catch {
        // Retain the bind failure over cleanup failures.
      }
      try {
        rootDispose?.();
      } catch {
        // Retain the bind failure over cleanup failures.
      }
      throw error;
    }
    state.cleanup = () => {
      let firstError: unknown;
      let failed = false;
      const run = (fn: (() => void) | undefined): void => {
        if (!fn) return;
        try {
          fn();
        } catch (error) {
          if (!failed) {
            firstError = error;
            failed = true;
          }
        }
      };
      run(innerCleanup);
      run(rootDispose);
      for (const node of nodes) {
        run(() => cleanupOwnedSubtree(node));
      }
      if (failed) throw firstError;
    };
  };

  const bindAdoptedWith = (resolved: unknown): void => {
    if (state.disposed || state.bound) return;
    state.bound = true;
    const nodes = clientShapedNodes(anchor.nextSibling, end);
    bindInOwner(nodes, resolved, true);
  };

  const settleAdopted = (): void => {
    if (state.disposed || state.bound) return;
    const gen = ++state.generation;
    if (isThenable(value)) {
      Promise.resolve(value).then(
        (resolved) => {
          if (state.disposed || state.generation !== gen) return;
          bindAdoptedWith(resolved);
        },
        () => undefined,
      );
    } else {
      bindAdoptedWith(value);
    }
  };

  const status = regionStatus(anchor, end);
  if (status === "error") {
    return;
  }
  if (status === "resolved") {
    settleAdopted();
    return;
  }
  if (status === "pending") {
    const handler: AwaitSwapHandler = (swapStatus) => {
      state.handler = undefined;
      const release = state.releaseObserver;
      state.releaseObserver = undefined;
      release?.();
      if (state.disposed || state.bound) return;
      if (swapStatus === "error") return;
      settleAdopted();
    };
    state.handler = handler;
    getAwaitHandlers().set(runtimeId, handler);
    if (observableRoot) {
      state.releaseObserver = retainPendingObserver(observableRoot);
    }
    return;
  }

  // Client mount (region starts empty between markers)
  const mountFresh = (resolved: unknown): void => {
    if (state.disposed || state.bound) return;
    state.bound = true;
    clearBetween(anchor, end);
    insertHtmlBefore(options.templateHtml, end);
    const nodes = clientShapedNodes(anchor.nextSibling, end);
    bindInOwner(nodes, resolved, false);
  };

  if (!isThenable(value)) {
    mountFresh(value);
    return;
  }

  if (options.pending) {
    // Use a client-only marker so stale SSR chunks targeting `<!--td:await:pending-->` cannot overwrite a client pending state.
    insertHtmlBefore(`<!--td:await:client-pending-->${options.pending}`, end);
  }
  const gen = ++state.generation;
  Promise.resolve(value).then(
    (resolved) => {
      if (state.disposed || state.generation !== gen) return;
      mountFresh(resolved);
    },
    () => {
      if (state.disposed || state.generation !== gen) return;
      clearBetween(anchor, end);
      if (options.error) {
        insertHtmlBefore(`<!--td:await:error-->${options.error}`, end);
      }
    },
  );
};
