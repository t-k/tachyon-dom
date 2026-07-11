import { compileServerTemplate } from "./compiler/index.js";
import { compileTachyonSfc, extractStaticSfcScope, generateSfcScriptDeclarations } from "./compiler/sfc.js";
import { escapeHtml } from "./html-escape.js";
import type { ClientBinding, CompiledTemplate, TemplateWhitespacePolicy } from "./compiler/types.js";
import { err, ok, type Result } from "./result.js";
import type { TemplateScope, TypedTemplate } from "./typed.js";
import { applyHtmlWhitespace, normalizeHtmlTagWhitespace, type HtmlWhitespacePolicy } from "./html-whitespace.js";

export type { HtmlWhitespacePolicy } from "./html-whitespace.js";
export { condenseHtmlWhitespace, normalizeHtmlTagWhitespace } from "./html-whitespace.js";

type TachyonAppPageBase = {
  path: string;
  fileName: string;
  title?: string;
  assetPrefix?: string;
  templateWhitespace?: TemplateWhitespacePolicy;
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
  templateWhitespace?: TemplateWhitespacePolicy;
};

export type TachyonAppDefinition<Pages extends readonly TachyonAppPage<any>[] = readonly TachyonAppPage[]> = {
  lang?: string;
  title?: string | ((page: TachyonAppPage) => string);
  pages: Pages;
  shell?: (context: TachyonAppShellContext) => string;
  assets?: TachyonAppAssets | ((page: TachyonAppPage) => TachyonAppAssets);
  notFound?: TachyonAppNotFoundPage;
  templateWhitespace?: TemplateWhitespacePolicy;
};

export type TachyonAppNotFoundPage = {
  title?: string;
  assets?: TachyonAppAssets;
  render: (context: { path: string }) => string;
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
  whitespace?: HtmlWhitespacePolicy;
  /** @deprecated Use `whitespace: "normalize-tags"` instead. */
  minify?: boolean;
};

export type TachyonAppHtmlEntry = {
  fileName: string;
  source: string;
  path: string;
};

export type TachyonAppRenderResult = {
  status: 200 | 404;
  html: string;
};

export type TachyonApp = {
  pages: readonly TachyonAppPage[];
  pageForPath: (path: string) => TachyonAppPage | undefined;
  renderRoute: (path: string) => string;
  renderShell: (path: string) => string;
  renderDocument: (path: string, options?: TachyonAppDocumentOptions) => string;
  renderResponse: (path: string, options?: TachyonAppDocumentOptions) => TachyonAppRenderResult;
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

const appPathMatches = (pattern: string, path: string): boolean => {
  const patternSegments = normalizeAppPath(pattern).split("/").filter(Boolean);
  const pathSegments = normalizeAppPath(path).split("/").filter(Boolean);
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    if (patternSegment?.startsWith("*")) return pathSegments.length >= index + 1;
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return false;
    if (!patternSegment?.startsWith(":") && patternSegment !== pathSegment) return false;
  }
  return patternSegments.length === pathSegments.length;
};

/** @deprecated Use `normalizeHtmlTagWhitespace()`. */
export const minifyHtml = normalizeHtmlTagWhitespace;

const templateSource = (template: string | TypedTemplate<TemplateScope>): string =>
  typeof template === "string" ? template : template.source;

const compilePage = (page: TachyonAppPage, templateWhitespace: TemplateWhitespacePolicy): CompiledTemplate => {
  const result = compileTachyonSfc(templateSource(page.template), { whitespace: templateWhitespace });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value.template;
};

const compilePageRenderer = (
  page: TachyonAppPage,
  templateWhitespace: TemplateWhitespacePolicy,
): ((scope: Record<string, unknown>) => string) => compileServerTemplate(compilePage(page, templateWhitespace));

const scopeForPage = (page: TachyonAppPage): Record<string, unknown> => {
  if (page.scope) return page.scope;
  const result = extractStaticSfcScope(templateSource(page.template));
  if (!result.ok) throw new Error(result.error);
  return result.value ?? {};
};

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

export const renderAppResponse = (
  app: TachyonApp,
  path: string,
  options: TachyonAppDocumentOptions = {},
): TachyonAppRenderResult => app.renderResponse(path, options);

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
    throw new Error(
      `Duplicate app pages:\n${duplicates.map(([key, group]) => `${key}: ${group.map((page) => page.fileName).join(", ")}`).join("\n")}`,
    );
  }
  const pagesByPath = new Map<string, TachyonAppPage>();
  for (const page of pages) {
    if (!pagesByPath.has(page.path)) {
      pagesByPath.set(page.path, page);
    }
  }
  const renderers = new Map<string, (scope: Record<string, unknown>) => string>();
  const pageForPath = (path: string): TachyonAppPage | undefined => {
    const normalized = normalizeAppPath(path);
    return pagesByPath.get(normalized) ?? pages.find((page) => appPathMatches(page.path, normalized));
  };

  const renderRoute = (path: string): string => {
    const page = pageForPath(path);
    if (!page) {
      return "";
    }
    const render =
      renderers.get(page.path) ??
      compilePageRenderer(page, page.templateWhitespace ?? definition.templateWhitespace ?? "preserve");
    renderers.set(page.path, render);
    return render(scopeForPage(page));
  };

  const renderShell = (path: string): string => {
    const page = pageForPath(path);
    if (!page) {
      return defaultShell({ page: { path: "/", fileName: "index.html", template: "" }, routeHtml: "" });
    }
    const routeHtml = renderRoute(page.path);
    return (definition.shell ?? defaultShell)({ page, routeHtml });
  };

  const documentFor = (
    page: TachyonAppPage,
    routeHtml: string,
    options: TachyonAppDocumentOptions,
    assetsOverride?: TachyonAppAssets,
  ): string => {
    const assets = assetsForPage(definition, page, options.assets ?? assetsOverride);
    const shell = (definition.shell ?? defaultShell)({ page, routeHtml });
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
    ${shell}
  </body>
</html>
`;
    const whitespace = options.whitespace ?? (options.minify ? "normalize-tags" : "preserve-tags");
    return applyHtmlWhitespace(html, whitespace);
  };

  const renderDocument = (path: string, options: TachyonAppDocumentOptions = {}): string => {
    const page = pageForPath(path);
    if (!page) {
      throw new Error(`No page found for ${path}.`);
    }
    return documentFor(page, renderRoute(page.path), options);
  };

  const renderResponse = (path: string, options: TachyonAppDocumentOptions = {}): TachyonAppRenderResult => {
    const page = pageForPath(path);
    if (page) {
      return { status: 200, html: renderDocument(page.path, options) };
    }
    const fallback = definition.notFound;
    const fallbackPage: TachyonAppPage = {
      path: normalizeAppPath(path),
      fileName: "404.html",
      title: fallback?.title ?? "Not Found",
      template: "",
    };
    const routeHtml = fallback?.render({ path }) ?? "<h1>Not Found</h1>";
    return { status: 404, html: documentFor(fallbackPage, routeHtml, options, fallback?.assets) };
  };

  return {
    pages,
    pageForPath,
    renderDocument,
    renderResponse,
    renderRoute,
    renderShell,
    entries: (options: TachyonAppDocumentOptions = {}) =>
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

export const pagesFromRouteFiles = (
  files: readonly string[],
  options: { rootDir: string; templateWhitespace?: TemplateWhitespacePolicy },
): TachyonAppPageFile[] =>
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
        ...(options.templateWhitespace ? { templateWhitespace: options.templateWhitespace } : {}),
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

const collectBindingRequirements = (binding: ClientBinding, fields: Map<string, string>): void => {
  const identifiers = new Set<string>();
  collectBindingIdentifiers(binding, identifiers);
  for (const identifier of identifiers) {
    if (!fields.has(identifier)) fields.set(identifier, "unknown");
  }
  if (binding.kind === "event" && /^[$A-Z_a-z][$\w]*$/.test(binding.handler)) {
    fields.set(binding.handler, "(event: Event) => unknown");
  }
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
  const scriptTypes = generateSfcScriptDeclarations(result.value.descriptor.script);
  if (!scriptTypes.ok) {
    return err(scriptTypes.error);
  }
  const typeName = options.typeName ?? "TemplateScope";
  const fields = new Map<string, string>();
  for (const binding of result.value.template.client.bindings) collectBindingRequirements(binding, fields);
  for (const store of result.value.template.client.stores) fields.set(store.name, "unknown");
  const requiredType = `type __TachyonRequiredScope = {\n${Array.from(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, type]) => `  ${name}: ${type};`)
    .join("\n")}\n};`;
  const hasNamedScope = /\bexport\s+declare\s+const\s+scope\s*:/.test(scriptTypes.value);
  const scopeType = hasNamedScope
    ? `type __TachyonAssertScope<T extends __TachyonRequiredScope> = T;\nexport type ${typeName} = __TachyonAssertScope<ReturnType<typeof scope>>;`
    : `export type ${typeName} = __TachyonRequiredScope;`;
  const templateExports = [
    `export declare const templateHtml: string;`,
    `export declare const hydrationBoundaries: unknown[];`,
    `export declare const componentBoundaries: unknown[];`,
    `export declare const bind: (root: Element, scope: ${typeName}) => void | (() => void);`,
  ].join("\n");
  return ok(
    [scriptTypes.value, requiredType, scopeType, templateExports].filter((part) => part.length > 0).join("\n\n") + "\n",
  );
};
