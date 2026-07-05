import { readFile } from "node:fs/promises";
import type { TachyonApp } from "./app.js";
import { diagnoseTachyonSfc, formatDiagnostic } from "./diagnostics.js";
import { renderServerTemplate } from "./compiler/index.js";
import { renderRoute, type RouteDefinition, type RouteRenderOptions, type RouteRenderResult } from "./router.js";

export const renderRouteForTest = async (
  routes: readonly RouteDefinition[],
  url: string,
  options: RouteRenderOptions = {},
): Promise<RouteRenderResult> => {
  const result = await renderRoute(routes, new URL(url, "https://example.test"), options);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

export type RouteParityCase = {
  path: string;
  clientHtml: string;
};

export const assertRouteParity = async (
  routes: readonly RouteDefinition[],
  cases: readonly RouteParityCase[],
  options: RouteRenderOptions = {},
): Promise<void> => {
  for (const testCase of cases) {
    const rendered = await renderRouteForTest(routes, testCase.path, options);
    if (rendered.html !== testCase.clientHtml) {
      throw new Error(
        `Route parity mismatch for ${testCase.path}: expected ${rendered.html}, received ${testCase.clientHtml}`,
      );
    }
  }
};

export const renderAppForTest = (app: TachyonApp, path: string): string => app.renderDocument(path);

export const assertAppHtml = (app: TachyonApp, path: string, expectedFragments: readonly string[]): void => {
  const html = renderAppForTest(app, path);
  const missing = expectedFragments.filter((fragment) => !html.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`App HTML assertion failed for ${path}: missing ${missing.join(", ")}`);
  }
};

export type RenderTdForTestOptions = {
  locale?: string;
};

export const renderTdForTest = async (
  templatePath: string,
  scope: Record<string, unknown> = {},
  options: RenderTdForTestOptions = {},
): Promise<string> => {
  const source = await readFile(templatePath, "utf8");
  const result = diagnoseTachyonSfc(source);
  if (!result.ok) {
    throw new Error(formatDiagnostic(result.error, templatePath));
  }
  const defaultScope = options.locale === undefined ? {} : { locale: options.locale };
  return renderServerTemplate(result.value.template, { ...defaultScope, ...scope });
};
