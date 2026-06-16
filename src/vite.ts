import type { Plugin } from "vite";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index";
import { diagnoseTemplate, formatDiagnostic } from "./diagnostics";
import { createFileRouteManifest } from "./router";
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
  routes?: readonly TachyonDomRouteModule[];
  files?: readonly string[];
  rootDir?: string;
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
  const routes = (): TachyonDomRouteModule[] => [
    ...(options.routes ?? []),
    ...(options.files && options.rootDir
      ? createFileRouteManifest(options.files, { rootDir: options.rootDir }).map((route) => ({
          id: route.id,
          path: route.path,
          module: route.file,
        }))
      : []),
  ];
  return {
    name: "tachyon-dom-routes",
    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : null;
    },
    load(id) {
      if (id !== resolvedVirtualId) {
        return null;
      }
      const modules = routes()
        .map(
          (route) =>
            `{ id: ${JSON.stringify(route.id)}, path: ${JSON.stringify(route.path)}, module: () => import(${JSON.stringify(route.module)}) }`,
        )
        .join(", ");
      return `export const routes = [${modules}];\nexport const manifest = routes.map(({ id, path }) => ({ id, path }));\n`;
    },
    handleHotUpdate(context) {
      const changed = routes().filter((route) => route.module === context.file);
      if (changed.length === 0) {
        return;
      }
      const module = context.server.moduleGraph.getModuleById(resolvedVirtualId);
      if (!module) {
        return;
      }
      context.server.moduleGraph.invalidateModule(module);
      context.server.ws.send({
        type: "custom",
        event: "tachyon-dom:routes-update",
        data: { routeIds: changed.map((route) => route.id) },
      });
      return [module, ...context.modules];
    },
  };
};

export default tachyonDom;
