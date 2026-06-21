declare module "*.td" {
  const defaultScope:
    | Record<string, unknown>
    | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export default defaultScope;
  export const templateHtml: string;
  export const hydrationBoundaries: unknown[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.td?raw" {
  const source: string;
  export default source;
}

declare module "*.tachyon" {
  const defaultScope:
    | Record<string, unknown>
    | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export default defaultScope;
  export const templateHtml: string;
  export const hydrationBoundaries: unknown[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.tachyon?raw" {
  const source: string;
  export default source;
}

declare module "*.tachyon.html" {
  const defaultScope:
    | Record<string, unknown>
    | ((scope: Record<string, unknown>) => Record<string, unknown>);
  export default defaultScope;
  export const templateHtml: string;
  export const hydrationBoundaries: unknown[];
  export const componentBoundaries: unknown[];
  export const bind: (root: Element, scope: Record<string, unknown>) => void | (() => void);
}

declare module "*.tachyon.html?raw" {
  const source: string;
  export default source;
}
