import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createNodeFetchHandler, type NodeFetchHandlerOptions, type StaticAssetOptions } from "./adapters/node.js";
import type { TachyonApp, TachyonAppAssets } from "./app.js";
import { generateScriptOnlyModule, transformSfcScript } from "./compiler/sfc.js";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index.js";
import { diagnoseTachyonSfc, formatDiagnostic, locateOffset } from "./diagnostics.js";
import { createFileRouteManifest } from "./router.js";
import { appendInlineSourceMap, createSourceMap, shouldEmitSourceMap, type SourceMap } from "./source-map.js";

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

export type TachyonAppViteOptions = {
  appScript?: string;
  minifyHtml?: boolean;
};

export type TachyonSsrContext = {
  clientScript?: string;
};

export type TachyonSsrFetchHandler = (
  request: Request,
  context: TachyonSsrContext,
) => Response | Promise<Response>;

export type TachyonSsrBypass = (url: URL, request: IncomingMessage) => boolean;

export type TachyonSsrMiddlewareOptions = Omit<NodeFetchHandlerOptions, "fetch"> & {
  fetch: TachyonSsrFetchHandler;
  clientScript?: string | ((request: Request) => string | undefined | Promise<string | undefined>);
  bypass?: TachyonSsrBypass;
};

export type TachyonSsrViteOptions = Omit<TachyonSsrMiddlewareOptions, "staticAssets"> & {
  staticAssets?: StaticAssetOptions | false;
};

export type TachyonSsrMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

const codeForTarget = (
  target: NonNullable<TachyonDomViteOptions["target"]>,
  template: Parameters<typeof generateClientModule>[0],
  reactive: boolean,
  scriptOnly: boolean,
  defaultScopeName?: string,
): string => {
  if (scriptOnly) {
    return generateScriptOnlyModule(target);
  }
  if (target === "server") {
    return generateServerModule(template);
  }
  if (target === "stream") {
    return generateServerStreamModule(template);
  }
  return generateClientModule(template, { reactive, ...(defaultScopeName ? { defaultScopeName } : {}) });
};

const cleanId = (id: string): string => id.split("?", 1)[0] ?? id;

const queryForId = (id: string): URLSearchParams => new URLSearchParams(id.split("?")[1] ?? "");

const targetForId = (
  id: string,
  fallback: NonNullable<TachyonDomViteOptions["target"]>,
): NonNullable<TachyonDomViteOptions["target"]> => {
  const query = queryForId(id);
  if (query.has("server")) {
    return "server";
  }
  if (query.has("stream")) {
    return "stream";
  }
  if (query.has("client")) {
    return "client";
  }
  return fallback;
};

const isEntryRequest = (id: string): boolean => queryForId(id).has("entry");

const shouldIgnoreQueryRequest = (id: string): boolean => {
  const query = queryForId(id);
  return query.has("raw") || query.has("url");
};

const entryCodeFor = (id: string): string => {
  const moduleId = cleanId(id);
  const query = queryForId(id);
  const mountName = query.get("mount") ?? "mount";
  return [
    `import * as module from ${JSON.stringify(moduleId)};`,
    `export * from ${JSON.stringify(moduleId)};`,
    `export default module;`,
    `const root = typeof document === "undefined" ? null : document.querySelector(${JSON.stringify(query.get("root") ?? "#app")});`,
    `const mount = module[${JSON.stringify(mountName)}] ?? module.mountApp ?? module.mountWebExample ?? module.mountAuthTodoExample ?? module.mountFullAppExample ?? module.default;`,
    `if (root instanceof HTMLElement && typeof mount === "function") {`,
    `  void mount(root);`,
    `}`,
  ].join("\n");
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
  const include = options.include ?? /\.(?:td|tachyon(?:\.html)?)$/;
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
      if (shouldIgnoreQueryRequest(id)) {
        return null;
      }
      if (isEntryRequest(id)) {
        return {
          code: entryCodeFor(id),
          map: null,
        };
      }
      if (!include.test(cleanId(id))) {
        return null;
      }
      const resolvedTarget = targetForId(id, target);
      const result = diagnoseTachyonSfc(source);
      if (!result.ok) {
        this.error(formatDiagnostic(result.error, id));
      }
      const script = transformSfcScript(result.value.descriptor.script);
      if (!script.ok) {
        this.error(formatDiagnostic({ ...script.error, ...locateOffset(source, script.error.offset) }, id));
      }
      const code = `${script.value.code}${codeForTarget(
        resolvedTarget,
        result.value.template,
        options.reactive === true,
        result.value.scriptOnly,
        resolvedTarget === "client" && script.value.defaultScopeName ? script.value.defaultScopeName : undefined,
      )}`;
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
    load(id) {
      if (shouldIgnoreQueryRequest(id)) {
        return null;
      }
      if (!include.test(cleanId(id)) || !isEntryRequest(id)) {
        return null;
      }
      return entryCodeFor(id);
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

const prefixed = (prefix: string, fileName: string): string => `${prefix}/${fileName}`;

const viteInternalExactPaths = ["/@vite/client", "/@react-refresh", "/__vite_ping"];
const viteInternalPrefixes = ["/@id/", "/@fs/", "/src/", "/node_modules/"];

export const isViteSsrPassthroughRequest = (url: URL): boolean =>
  viteInternalExactPaths.includes(url.pathname) || viteInternalPrefixes.some((prefix) => url.pathname.startsWith(prefix));

const resolveClientScript = async (
  request: Request,
  clientScript: TachyonSsrMiddlewareOptions["clientScript"],
): Promise<string | undefined> => {
  if (typeof clientScript === "function") {
    return clientScript(request);
  }
  return clientScript;
};

export const createTachyonSsrMiddleware = (options: TachyonSsrMiddlewareOptions): TachyonSsrMiddleware => {
  const { fetch, clientScript, bypass = isViteSsrPassthroughRequest, ...adapterOptions } = options;
  const handler = createNodeFetchHandler({
    ...adapterOptions,
    fetch: async (request) => {
      const resolvedClientScript = await resolveClientScript(request, clientScript);
      return fetch(request, resolvedClientScript ? { clientScript: resolvedClientScript } : {});
    },
  });
  return (request, response, next) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://tachyon.local");
    } catch {
      next();
      return;
    }
    if (bypass(url, request)) {
      next();
      return;
    }
    void handler(request, response).catch((error: unknown) => next(error));
  };
};

export const tachyonSsr = (options: TachyonSsrViteOptions): Plugin => ({
  name: "tachyon-dom-ssr",
  configureServer(server) {
    const { staticAssets = { rootDir: server.config.publicDir, basePath: "/", fallthroughOnNotFound: true }, ...rest } =
      options;
    server.middlewares.use(
      createTachyonSsrMiddleware({
        ...rest,
        ...(staticAssets === false ? {} : { staticAssets }),
      }),
    );
  },
});

export const tachyonApp = (app: TachyonApp, options: TachyonAppViteOptions = {}): Plugin => ({
  name: "tachyon-dom-app",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const page = app.pageForPath(new URL(request.url ?? "/", "http://tachyon.local").pathname);
      if (!page) {
        next();
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        app.renderDocument(page.path, {
          assets: {
            scripts: [options.appScript ?? `${page.assetPrefix ?? "."}/main.ts`],
            styles: [`${page.assetPrefix ?? "."}/styles.css`],
          },
        }),
      );
    });
  },
  generateBundle(_outputOptions, bundle) {
    const entry = Object.values(bundle).find((item) => item.type === "chunk" && item.isEntry);
    const cssFiles = Object.values(bundle).flatMap((item) =>
      item.type === "asset" && item.fileName.endsWith(".css") ? [item.fileName] : [],
    );
    for (const page of app.pages) {
      const prefix = page.assetPrefix ?? ".";
      const assets: TachyonAppAssets = {
        scripts: entry && entry.type === "chunk" ? [prefixed(prefix, entry.fileName)] : [],
        styles: cssFiles.map((fileName) => prefixed(prefix, fileName)),
      };
      this.emitFile({
        fileName: page.fileName,
        source: app.renderDocument(page.path, { assets, minify: options.minifyHtml ?? true }),
        type: "asset",
      });
    }
  },
});

export default tachyonDom;
