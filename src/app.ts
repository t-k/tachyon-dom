import { compileServerTemplate, compileTemplate } from "./compiler/index.js";
import { compileTachyonSfc, generateSfcScriptDeclarations } from "./compiler/sfc.js";
import { escapeHtml } from "./html-escape.js";
import type { ClientBinding, CompiledTemplate } from "./compiler/types.js";
import { err, ok, type Result } from "./result.js";
import type { TemplateScope, TypedTemplate } from "./typed.js";

type TachyonAppPageBase = {
  path: string;
  fileName: string;
  title?: string;
  assetPrefix?: string;
};

export type TachyonAppPage<Scope extends TemplateScope = TemplateScope> = TachyonAppPageBase &
  (
    | {
        template: string;
        scope?: Record<string, unknown>;
      }
    | {
        template: TypedTemplate<Scope>;
        scope: Scope;
      }
  );

export type TachyonAppPageFile = {
  path: string;
  fileName: string;
  file: string;
  assetPrefix?: string;
};

export type TachyonAppDefinition<Pages extends readonly TachyonAppPage<any>[] = readonly TachyonAppPage[]> = {
  lang?: string;
  title?: string | ((page: TachyonAppPage) => string);
  pages: Pages;
  shell?: (context: TachyonAppShellContext) => string;
  assets?: TachyonAppAssets | ((page: TachyonAppPage) => TachyonAppAssets);
};

export type TachyonAppAssets = {
  scripts?: readonly string[];
  styles?: readonly string[];
};

export type TachyonAppShellContext = {
  page: TachyonAppPage;
  routeHtml: string;
};

export type TachyonAppDocumentOptions = {
  assets?: TachyonAppAssets;
  minify?: boolean;
};

export type TachyonAppHtmlEntry = {
  fileName: string;
  source: string;
  path: string;
};

export type TachyonApp = {
  pages: readonly TachyonAppPage[];
  pageForPath: (path: string) => TachyonAppPage | undefined;
  renderRoute: (path: string) => string;
  renderShell: (path: string) => string;
  renderDocument: (path: string, options?: TachyonAppDocumentOptions) => string;
  entries: (options?: TachyonAppDocumentOptions) => TachyonAppHtmlEntry[];
};

type ValidateTypedPageScopes<Pages extends readonly TachyonAppPage<any>[]> = {
  readonly [Index in keyof Pages]: Pages[Index] extends { template: TypedTemplate<infer Scope>; scope: infer Given }
    ? Given extends Scope
      ? Pages[Index]
      : never
    : Pages[Index];
};

export type TemplateTypeOptions = {
  typeName?: string;
};

const templateExtensions = /\.(?:td|tachyon(?:\.html)?)$/;
const ignoredIdentifiers = new Set([
  "Array",
  "Boolean",
  "Date",
  "Math",
  "Number",
  "Object",
  "String",
  "false",
  "null",
  "true",
  "undefined",
]);
export const normalizeAppPath = (path: string): string => {
  if (path === "" || path === "/" || path === "/index.html") {
    return "/";
  }
  const withoutIndex = path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path;
  return withoutIndex.endsWith("/") ? withoutIndex : `${withoutIndex}/`;
};

export const minifyHtml = (html: string): string => {
  const preserved: string[] = [];
  const preserve = (match: string): string => {
    preserved.push(match);
    return `___TACHYON_PRESERVE_${preserved.length - 1}___`;
  };
  const minified = html
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, preserve)
    .replace(/<!--(?!\[if\b)[\s\S]*?-->/gi, "")
    .replace(/\s+</g, "<")
    .replace(/>\s+/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/___TACHYON_PRESERVE_(\d+)___/g, (_match, index: string) => preserved[Number(index)] ?? "");
  return `${minified}\n`;
};

const templateSource = (template: string | TypedTemplate<TemplateScope>): string =>
  typeof template === "string" ? template : template.source;

const compilePage = (page: TachyonAppPage): CompiledTemplate => {
  const result = compileTemplate(templateSource(page.template));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

const compilePageRenderer = (page: TachyonAppPage): ((scope: Record<string, unknown>) => string) =>
  compileServerTemplate(compilePage(page));

const defaultShell = ({ routeHtml }: TachyonAppShellContext): string => `<main id="app">${routeHtml}</main>`;

const assetsForPage = (
  app: TachyonAppDefinition,
  page: TachyonAppPage,
  override?: TachyonAppAssets,
): TachyonAppAssets => {
  if (override) {
    return override;
  }
  return typeof app.assets === "function" ? app.assets(page) : (app.assets ?? {});
};

const titleForPage = (app: TachyonAppDefinition, page: TachyonAppPage): string => {
  if (typeof app.title === "function") {
    return app.title(page);
  }
  return page.title ?? app.title ?? "Tachyon App";
};

export const renderAppDocument = (app: TachyonApp, path: string, options: TachyonAppDocumentOptions = {}): string =>
  app.renderDocument(path, options);

export const defineApp = <const Pages extends readonly TachyonAppPage<any>[]>(
  definition: Omit<TachyonAppDefinition<Pages>, "pages"> & { pages: ValidateTypedPageScopes<Pages> },
): TachyonApp => {
  const pages = definition.pages.map((page) => ({
    ...page,
    path: normalizeAppPath(page.path),
  }));
  const conflicts = new Map<string, TachyonAppPage[]>();
  for (const page of pages) {
    for (const key of [`path ${page.path}`, `file ${page.fileName}`]) {
      const group = conflicts.get(key) ?? [];
      group.push(page);
      conflicts.set(key, group);
    }
  }
  const duplicates = [...conflicts.entries()].filter(([, group]) => group.length > 1);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate app pages:\n${duplicates.map(([key, group]) => `${key}: ${group.map((page) => page.fileName).join(", ")}`).join("\n")}`);
  }
  const pagesByPath = new Map<string, TachyonAppPage>();
  for (const page of pages) {
    if (!pagesByPath.has(page.path)) {
      pagesByPath.set(page.path, page);
    }
  }
  const renderers = new Map<string, (scope: Record<string, unknown>) => string>();
  const pageForPath = (path: string): TachyonAppPage | undefined => pagesByPath.get(normalizeAppPath(path));

  const renderRoute = (path: string): string => {
    const page = pageForPath(path);
    if (!page) {
      return "";
    }
    const render = renderers.get(page.path) ?? compilePageRenderer(page);
    renderers.set(page.path, render);
    return render(page.scope ?? {});
  };

  const renderShell = (path: string): string => {
    const page = pageForPath(path);
    if (!page) {
      return defaultShell({ page: { path: "/", fileName: "index.html", template: "" }, routeHtml: "" });
    }
    const routeHtml = renderRoute(page.path);
    return (definition.shell ?? defaultShell)({ page, routeHtml });
  };

  const renderDocument = (path: string, options: TachyonAppDocumentOptions = {}): string => {
    const page = pageForPath(path);
    if (!page) {
      throw new Error(`No page found for ${path}.`);
    }
    const assets = assetsForPage(definition, page, options.assets);
    const html = `<!doctype html>
<html lang="${escapeHtml(definition.lang ?? "en")}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(titleForPage(definition, page))}</title>
    ${(assets.styles ?? []).map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}" />`).join("\n    ")}
    ${(assets.scripts ?? []).map((src) => `<script type="module" src="${escapeHtml(src)}"></script>`).join("\n    ")}
  </head>
  <body>
    ${renderShell(page.path)}
  </body>
</html>
`;
    return options.minify ? minifyHtml(html) : html;
  };

  return {
    pages,
    pageForPath,
    renderDocument,
    renderRoute,
    renderShell,
    entries: (options = {}) =>
      pages.map((page) => ({
        fileName: page.fileName,
        path: page.path,
        source: renderDocument(page.path, options),
      })),
  };
};

const routeSegmentsForFile = (file: string, rootDir: string): string[] => {
  const relative = file.startsWith(rootDir) ? file.slice(rootDir.length).replace(/^[/\\]/, "") : file;
  const withoutExtension = relative.replace(templateExtensions, "");
  const parts = withoutExtension.split(/[/\\]/).filter(Boolean);
  if (parts.at(-1) === "page") {
    parts.pop();
  }
  return parts.filter((part) => part !== "index");
};

const segmentToRoute = (segment: string): string => {
  if (/^\[\.\.\.[^[\]]+\]$/.test(segment)) {
    return `*${segment.slice(4, -1)}`;
  }
  if (/^\[[^[\]]+\]$/.test(segment)) {
    return `:${segment.slice(1, -1)}`;
  }
  return segment;
};

const segmentToFileName = (segment: string): string => segment;

const assetPrefixForDepth = (depth: number): string =>
  depth <= 0 ? "." : Array.from({ length: depth }, () => "..").join("/");

export const pagesFromRouteFiles = (files: readonly string[], options: { rootDir: string }): TachyonAppPageFile[] =>
  files
    .filter((file) => templateExtensions.test(file))
    .map((file) => {
      const segments = routeSegmentsForFile(file, options.rootDir);
      const path = segments.length === 0 ? "/" : `/${segments.map(segmentToRoute).join("/")}/`;
      const fileName = segments.length === 0 ? "index.html" : `${segments.map(segmentToFileName).join("/")}/index.html`;
      return {
        assetPrefix: assetPrefixForDepth(segments.length),
        file,
        fileName,
        path,
      };
    });

const collectExpressionIdentifiers = (expression: string, identifiers: Set<string>): void => {
  for (const match of expression.matchAll(/\b[$A-Z_a-z][$\w]*\b/g)) {
    const name = match[0];
    const previous = expression[match.index - 1];
    if (previous === "." || ignoredIdentifiers.has(name)) {
      continue;
    }
    identifiers.add(name);
  }
};

const collectBindingIdentifiers = (binding: ClientBinding, identifiers: Set<string>): void => {
  if (binding.kind === "event") {
    collectExpressionIdentifiers(binding.handler, identifiers);
    return;
  }
  if (binding.kind === "list") {
    collectExpressionIdentifiers(binding.each, identifiers);
    collectExpressionIdentifiers(binding.key, identifiers);
    for (const child of binding.bindings) {
      collectBindingIdentifiers(child, identifiers);
    }
    identifiers.delete(binding.itemName);
    return;
  }
  if (binding.kind === "if") {
    collectExpressionIdentifiers(binding.test, identifiers);
    for (const child of binding.bindings) {
      collectBindingIdentifiers(child, identifiers);
    }
    return;
  }
  collectExpressionIdentifiers(binding.expression, identifiers);
};

export const generateTemplateTypes = (source: string, options: TemplateTypeOptions = {}): Result<string, string> => {
  const result = compileTachyonSfc(source);
  if (!result.ok) {
    return err(result.error.message);
  }
  const identifiers = new Set<string>();
  for (const binding of result.value.template.client.bindings) {
    collectBindingIdentifiers(binding, identifiers);
  }
  for (const store of result.value.template.client.stores) {
    identifiers.add(store.name);
  }
  const typeName = options.typeName ?? "TemplateScope";
  const fields = Array.from(identifiers)
    .sort()
    .map((name) => `  ${name}: unknown;`)
    .join("\n");
  return ok(`export type ${typeName} = {\n${fields ? `${fields}\n` : ""}};\n`);
};

export const generateTachyonModuleTypes = (
  source: string,
  options: TemplateTypeOptions = {},
): Result<string, string> => {
  const result = compileTachyonSfc(source);
  if (!result.ok) {
    return err(result.error.message);
  }
  const scopeTypes = generateTemplateTypes(source, options);
  if (!scopeTypes.ok) {
    return err(scopeTypes.error);
  }
  const scriptTypes = generateSfcScriptDeclarations(result.value.descriptor.script);
  if (!scriptTypes.ok) {
    return err(scriptTypes.error);
  }
  const typeName = options.typeName ?? "TemplateScope";
  const templateExports = [
    `export declare const templateHtml: string;`,
    `export declare const hydrationBoundaries: unknown[];`,
    `export declare const componentBoundaries: unknown[];`,
    `export declare const bind: (root: Element, scope: ${typeName} & Record<string, unknown>) => void | (() => void);`,
  ].join("\n");
  return ok(
    [scriptTypes.value, scopeTypes.value.trim(), templateExports].filter((part) => part.length > 0).join("\n\n") + "\n",
  );
};
