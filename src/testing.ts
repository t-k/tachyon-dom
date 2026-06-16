import { renderRoute, type RouteDefinition, type RouteRenderOptions, type RouteRenderResult } from "./router";

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
