export {};

type __TachyonRequiredScope = {
  count: unknown;
  draft: unknown;
  increment: unknown;
  shared: unknown;
  sharedText: unknown;
  shown: unknown;
};

export type TemplateScope = __TachyonRequiredScope;

type __TachyonHydrationDynamicAttribute = { path: readonly number[]; name: string; kind?: "value" | "token" };
type __TachyonHydrationDynamicRegion = { path: readonly number[]; index: number; kind: "list" | "conditional" };
export declare const templateHtml: string;
type __TachyonHydrationBoundary = { id: string; idKind?: "expression" | "static"; path?: readonly number[]; strategy?: "load" | "idle" | "visible" | "media" | "interaction"; media?: string; interaction?: string; rootMargin?: string; };
export declare const hydrationBoundaries: readonly __TachyonHydrationBoundary[];
export declare const hydrationDynamicAttributes: readonly __TachyonHydrationDynamicAttribute[];
export declare const hydrationDynamicRegions: readonly __TachyonHydrationDynamicRegion[];
export declare const componentBoundaries: unknown[];
export declare const bind: (root: Element, scope: TemplateScope) => void | (() => void);
