import type { Plugin } from "vite";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index";
import { diagnoseTemplate, formatDiagnostic } from "./diagnostics";
import { appendInlineSourceMap, createSourceMap } from "./source-map";

export type TachyonDomViteOptions = {
  include?: RegExp;
  target?: "client" | "server" | "stream";
  reactive?: boolean;
};

export type TachyonDomRouteModule = {
  id: string;
  path: string;
  module: string;
};

export type TachyonDomRoutesViteOptions = {
  routes: readonly TachyonDomRouteModule[];
  virtualId?: string;
};

const codeForTarget = (
  target: NonNullable<TachyonDomViteOptions["target"]>,
  template: Parameters<typeof generateClientModule>[0],
  reactive: boolean,
): string => {
  if (target === "server") {
    return generateServerModule(template);
  }
  if (target === "stream") {
    return generateServerStreamModule(template);
  }
  return generateClientModule(template, { reactive });
};

export const tachyonDom = (options: TachyonDomViteOptions = {}): Plugin => {
  const include = options.include ?? /\.tachyon\.html$/;
  const target = options.target ?? "client";
  return {
    name: "tachyon-dom",
    enforce: "pre",
    transform(source, id) {
      if (!include.test(id)) {
        return null;
      }
      const result = diagnoseTemplate(source);
      if (!result.ok) {
        this.error(formatDiagnostic(result.error, id));
      }
      const code = codeForTarget(target, result.value, options.reactive === true);
      return {
        code: appendInlineSourceMap(code, createSourceMap(source, id, `${id}.js`)),
        map: null,
      };
    },
  };
};

export const tachyonDomRoutes = (options: TachyonDomRoutesViteOptions): Plugin => {
  const virtualId = options.virtualId ?? "virtual:tachyon-dom/routes";
  const resolvedVirtualId = `\0${virtualId}`;
  const routeModules = new Set(options.routes.map((route) => route.module));
  return {
    name: "tachyon-dom-routes",
    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : null;
    },
    load(id) {
      if (id !== resolvedVirtualId) {
        return null;
      }
      const routes = options.routes
        .map(
          (route) =>
            `{ id: ${JSON.stringify(route.id)}, path: ${JSON.stringify(route.path)}, module: () => import(${JSON.stringify(route.module)}) }`,
        )
        .join(", ");
      return `export const routes = [${routes}];\nexport const manifest = routes.map(({ id, path }) => ({ id, path }));\n`;
    },
    handleHotUpdate(context) {
      if (!routeModules.has(context.file)) {
        return;
      }
      const module = context.server.moduleGraph.getModuleById(resolvedVirtualId);
      if (!module) {
        return;
      }
      context.server.moduleGraph.invalidateModule(module);
      return [module, ...context.modules];
    },
  };
};

export default tachyonDom;
