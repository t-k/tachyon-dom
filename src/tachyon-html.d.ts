type TachyonHydrationBoundary = {
  id: string;
  idKind?: "expression" | "static";
  path?: readonly number[];
  strategy?: "load" | "idle" | "visible" | "media" | "interaction";
  media?: string;
  interaction?: string;
  rootMargin?: string;
};

declare module "*.td" {
  const defaultScope: Record<string, unknown> | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export default defaultScope;
  export const scope: Record<string, unknown> | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export const templateHtml: string;
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const hydrationDynamicAttributes: readonly {
    path: readonly number[];
    name: string;
    kind?: "value" | "token";
  }[];
  export const hydrationDynamicRegions: readonly {
    path: readonly number[];
    index: number;
    kind: "list" | "conditional";
  }[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.td?raw" {
  const source: string;
  export default source;
}

declare module "*.td?client" {
  export const templateHtml: string;
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const hydrationDynamicAttributes: readonly {
    path: readonly number[];
    name: string;
    kind?: "value" | "token";
  }[];
  export const hydrationDynamicRegions: readonly {
    path: readonly number[];
    index: number;
    kind: "list" | "conditional";
  }[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.td?client&hydrate-only" {
  export const hydrateOnly: true;
  export const templateHtml: string;
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const hydrationDynamicAttributes: readonly {
    path: readonly number[];
    name: string;
    kind?: "value" | "token";
  }[];
  export const hydrationDynamicRegions: readonly {
    path: readonly number[];
    index: number;
    kind: "list" | "conditional";
  }[];
  export const componentBoundaries: unknown[];
  export const hydrate: (
    bindRoot: Element,
    hydrationRoot: ParentNode,
    scope: Record<string, unknown>,
  ) => void | (() => void);
}

declare module "*.td?server" {
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const renderHydrationState: (id: string, state: unknown) => string;
  export const render: (scope: Record<string, unknown>) => string;
}

declare module "*.td?stream" {
  export const stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
}

declare module "*.td?entry" {
  const module: Record<string, unknown>;
  export default module;
}

declare module "*.tachyon" {
  const defaultScope: Record<string, unknown> | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export default defaultScope;
  export const scope: Record<string, unknown> | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export const templateHtml: string;
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const hydrationDynamicAttributes: readonly {
    path: readonly number[];
    name: string;
    kind?: "value" | "token";
  }[];
  export const hydrationDynamicRegions: readonly {
    path: readonly number[];
    index: number;
    kind: "list" | "conditional";
  }[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.tachyon?raw" {
  const source: string;
  export default source;
}

declare module "*.tachyon?client" {
  export const templateHtml: string;
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const hydrationDynamicAttributes: readonly {
    path: readonly number[];
    name: string;
    kind?: "value" | "token";
  }[];
  export const hydrationDynamicRegions: readonly {
    path: readonly number[];
    index: number;
    kind: "list" | "conditional";
  }[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.tachyon?server" {
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const renderHydrationState: (id: string, state: unknown) => string;
  export const render: (scope: Record<string, unknown>) => string;
}

declare module "*.tachyon?stream" {
  export const stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
}

declare module "*.tachyon?entry" {
  const module: Record<string, unknown>;
  export default module;
}

declare module "*.tachyon.html" {
  const defaultScope: Record<string, unknown> | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export default defaultScope;
  export const scope: Record<string, unknown> | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export const templateHtml: string;
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const hydrationDynamicAttributes: readonly {
    path: readonly number[];
    name: string;
    kind?: "value" | "token";
  }[];
  export const hydrationDynamicRegions: readonly {
    path: readonly number[];
    index: number;
    kind: "list" | "conditional";
  }[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.tachyon.html?raw" {
  const source: string;
  export default source;
}

declare module "*.tachyon.html?client" {
  export const templateHtml: string;
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const hydrationDynamicAttributes: readonly {
    path: readonly number[];
    name: string;
    kind?: "value" | "token";
  }[];
  export const hydrationDynamicRegions: readonly {
    path: readonly number[];
    index: number;
    kind: "list" | "conditional";
  }[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.tachyon.html?server" {
  export const hydrationBoundaries: readonly TachyonHydrationBoundary[];
  export const renderHydrationState: (id: string, state: unknown) => string;
  export const render: (scope: Record<string, unknown>) => string;
}

declare module "*.tachyon.html?stream" {
  export const stream: (scope: Record<string, unknown>) => AsyncIterable<string>;
}

declare module "*.tachyon.html?entry" {
  const module: Record<string, unknown>;
  export default module;
}
