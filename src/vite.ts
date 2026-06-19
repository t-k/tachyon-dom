import type { Plugin } from "vite";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index";
import { diagnoseTemplate, formatDiagnostic } from "./diagnostics";
import { createFileRouteManifest } from "./router";
import { appendInlineSourceMap, createSourceMap, shouldEmitSourceMap, type SourceMap } from "./source-map";

export type TachyonDomViteOptions = {
  include?: RegExp;
  target?: "client" | "server" | "stream";
  reactive?: boolean;
  sourcemap?: boolean;
  productionSourceMap?: boolean;
  requestLog?: boolean | TachyonDomRequestLogOptions;
  onSourceMap?: (artifact: { id: string; code: string; map: SourceMap; source: string }) => void | Promise<void>;
};

export type TachyonDomRequestLogOptions = {
  enabled?: boolean;
  includeQuery?: boolean;
  logger?: (message: string) => void;
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

const shouldLogRequests = (options: TachyonDomViteOptions["requestLog"]): boolean =>
  options === undefined || options === true || (typeof options === "object" && options.enabled !== false);

const requestLogPath = (url: string | undefined, includeQuery: boolean): string => {
  if (!url) {
    return "/";
  }
  const parsed = new URL(url, "http://tachyon.local");
  return includeQuery ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
};

export const tachyonDom = (options: TachyonDomViteOptions = {}): Plugin => {
  const include = options.include ?? /\.tachyon\.html$/;
  const target = options.target ?? "client";
  let command = "serve";
  let mode = "development";
  return {
    name: "tachyon-dom",
    enforce: "pre",
    configResolved(config) {
      command = config.command;
      mode = config.mode;
    },
    configureServer(server) {
      if (!shouldLogRequests(options.requestLog)) {
        return;
      }
      const log =
        typeof options.requestLog === "object" && options.requestLog.logger
          ? options.requestLog.logger
          : (message: string) => server.config.logger.info(message, { timestamp: true });
      server.middlewares.use((request, response, next) => {
        const startedAt = performance.now();
        const method = request.method ?? "GET";
        const path = requestLogPath(
          request.url,
          typeof options.requestLog === "object" && options.requestLog.includeQuery === true,
        );
        response.once("finish", () => {
          const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
          log(`${method} ${path} ${response.statusCode} ${durationMs}ms`);
        });
        next();
      });
    },
    async transform(source, id) {
      if (!include.test(id)) {
        return null;
      }
      const result = diagnoseTemplate(source);
      if (!result.ok) {
        this.error(formatDiagnostic(result.error, id));
      }
      const code = codeForTarget(target, result.value, options.reactive === true);
      const emitSourceMap = shouldEmitSourceMap({
        sourcemap: options.sourcemap,
        productionSourceMap: options.productionSourceMap,
        command,
        mode,
      });
      if (!emitSourceMap && (!options.onSourceMap || options.sourcemap === false)) {
        return {
          code,
          map: null,
        };
      }
      const map = createSourceMap(source, id, `${id}.js`);
      await options.onSourceMap?.({ id, code, map, source });
      return {
        code: emitSourceMap ? appendInlineSourceMap(code, map) : code,
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
