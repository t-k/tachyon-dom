import { compileTemplate, renderServerTemplate } from "./compiler/index";
import type { ClientBinding, CompiledTemplate } from "./compiler/types";
import { err, ok, type Result } from "./result";

export type TachyonAppPage = {
  path: string;
  fileName: string;
  template: string;
  scope?: Record<string, unknown>;
  title?: string;
  assetPrefix?: string;
};

export type TachyonAppPageFile = {
  path: string;
  fileName: string;
  file: string;
  assetPrefix?: string;
};

export type TachyonAppDefinition = {
  lang?: string;
  title?: string | ((page: TachyonAppPage) => string);
  pages: readonly TachyonAppPage[];
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

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

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

const compilePage = (page: TachyonAppPage): CompiledTemplate => {
  const result = compileTemplate(page.template);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

const defaultShell = ({ routeHtml }: TachyonAppShellContext): string => `<main id="app">${routeHtml}</main>`;

const assetsForPage = (app: TachyonAppDefinition, page: TachyonAppPage, override?: TachyonAppAssets): TachyonAppAssets => {
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

export const renderAppDocument = (
  app: TachyonApp,
  path: string,
  options: TachyonAppDocumentOptions = {},
): string => app.renderDocument(path, options);

export const defineApp = (definition: TachyonAppDefinition): TachyonApp => {
  const pages = definition.pages.map((page) => ({
    ...page,
    path: normalizeAppPath(page.path),
  }));
  const compiled = new Map<string, CompiledTemplate>();
  const pageForPath = (path: string): TachyonAppPage | undefined =>
    pages.find((page) => page.path === normalizeAppPath(path));

  const renderRoute = (path: string): string => {
    const page = pageForPath(path) ?? pageForPath("/");
    if (!page) {
      return "";
    }
    const cached = compiled.get(page.path) ?? compilePage(page);
    compiled.set(page.path, cached);
    return renderServerTemplate(cached, page.scope ?? {});
  };

  const renderShell = (path: string): string => {
    const page = pageForPath(path) ?? pageForPath("/");
    if (!page) {
      return defaultShell({ page: { path: "/", fileName: "index.html", template: "" }, routeHtml: "" });
    }
    const routeHtml = renderRoute(page.path);
    return (definition.shell ?? defaultShell)({ page, routeHtml });
  };

  const renderDocument = (path: string, options: TachyonAppDocumentOptions = {}): string => {
    const page = pageForPath(path) ?? pageForPath("/");
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

const assetPrefixForDepth = (depth: number): string => (depth <= 0 ? "." : Array.from({ length: depth }, () => "..").join("/"));

export const pagesFromRouteFiles = (
  files: readonly string[],
  options: { rootDir: string },
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

export const generateTemplateTypes = (
  source: string,
  options: TemplateTypeOptions = {},
): Result<string, string> => {
  const result = compileTemplate(source);
  if (!result.ok) {
    return err(result.error.message);
  }
  const identifiers = new Set<string>();
  for (const binding of result.value.client.bindings) {
    collectBindingIdentifiers(binding, identifiers);
  }
  for (const store of result.value.client.stores) {
    identifiers.add(store.name);
  }
  const typeName = options.typeName ?? "TemplateScope";
  const fields = Array.from(identifiers)
    .sort()
    .map((name) => `  ${name}: unknown;`)
    .join("\n");
  return ok(`export type ${typeName} = {\n${fields ? `${fields}\n` : ""}};\n`);
};
