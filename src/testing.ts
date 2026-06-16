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
