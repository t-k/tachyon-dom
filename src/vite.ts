import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createNodeFetchHandler, type NodeFetchHandlerOptions, type StaticAssetOptions } from "./adapters/node.js";
import {
  defineApp,
  generateTachyonModuleTypes,
  pagesFromRouteFiles,
  type TachyonApp,
  type TachyonAppAssets,
  type TachyonAppDefinition,
} from "./app.js";
import { resolveHtmlWhitespacePolicy, type HtmlWhitespacePolicy } from "./html-whitespace.js";
import { generateScriptOnlyModule, transformSfcScript } from "./compiler/sfc.js";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index.js";
import type { TemplateWhitespacePolicy } from "./compiler/types.js";
import { diagnoseTachyonSfc, diagnosticFromCompilerError, formatDiagnostic } from "./diagnostics.js";
import { createFileRouteManifest } from "./router.js";
import { scanFileRoutes } from "./router-node.js";
import { err, ok, type Result } from "./result.js";
import { appendInlineSourceMap, createSourceMap, shouldEmitSourceMap, type SourceMap } from "./source-map.js";
import { checkTachyonTemplateTypes, formatTemplateTypeDiagnostic } from "./template-typecheck.js";

export type TachyonDomViteOptions = {
  include?: RegExp;
  target?: "client" | "server" | "stream";
  reactive?: boolean;
  templateWhitespace?: TemplateWhitespacePolicy;
  sourcemap?: boolean;
  productionSourceMap?: boolean;
  requestLog?: boolean | TachyonDomRequestLogOptions;
  declarationOutput?: false | ((id: string) => string | undefined);
  typecheck?: boolean;
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
  /**
   * `"always"` (the default) puts the client entry on every page. `"when-required"` omits it from pages the
   * compiler proves need no client work: no client binding, hydration boundary, store, component boundary, or
   * `<script setup>`. A shared entry's own side effects then do not run on those pages.
   */
  clientEntry?: "always" | "when-required";
  htmlWhitespace?: HtmlWhitespacePolicy;
  /** @deprecated Use `htmlWhitespace` instead. */
  minifyHtml?: boolean;
};

const canonicalPath = async (value: string): Promise<string> => {
  let existingAncestor = resolve(value);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return join(await realpath(existingAncestor), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
};

const isPathInside = async (root: string, candidate: string): Promise<boolean> => {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([canonicalPath(root), canonicalPath(candidate)]);
  const candidateRelativePath = relative(canonicalRoot, canonicalCandidate);
  return (
    candidateRelativePath === "" ||
    (candidateRelativePath !== ".." &&
      !candidateRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(candidateRelativePath))
  );
};

const configuredAppHtmlWhitespace = (options: TachyonAppViteOptions): HtmlWhitespacePolicy | undefined => {
  if (options.htmlWhitespace !== undefined) return resolveHtmlWhitespacePolicy(options.htmlWhitespace);
  if (options.minifyHtml !== undefined) return options.minifyHtml ? "normalize-tags" : "preserve-tags";
  return undefined;
};

export type TachyonRouteAppOptions = Omit<TachyonAppDefinition, "pages"> & {
  routesDir: string;
};

export const loadRouteApp = async ({ routesDir, ...definition }: TachyonRouteAppOptions): Promise<TachyonApp> => {
  const absoluteRoutesDir = resolve(routesDir);
  const manifest = await scanFileRoutes(absoluteRoutesDir);
  const pageFiles = manifest.filter((route) => route.kind === "template").map((route) => route.file);
  const pages = await Promise.all(
    pagesFromRouteFiles(pageFiles, {
      rootDir: absoluteRoutesDir,
      ...(definition.templateWhitespace ? { templateWhitespace: definition.templateWhitespace } : {}),
    }).map(async (page) => ({
      ...page,
      template: await readFile(page.file, "utf8"),
    })),
  );
  return defineApp({ ...definition, pages });
};

export type TachyonSsrContext = {
  clientScript?: string;
};

export type TachyonSsrFetchHandler = (request: Request, context: TachyonSsrContext) => Response | Promise<Response>;

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

export type CloudflarePagesPackageOptions = {
  entry: string;
  outDir: string;
  assetsDir?: string;
  exportName?: string;
  fallthroughStatuses?: readonly number[];
  runtimeEnvKeys?: readonly string[];
};

export type CloudflarePagesPackageResult = {
  outDir: string;
  workerPath: string;
};

const cloudflarePagesWorkerSource = (options: CloudflarePagesPackageOptions): string => {
  const exportName = options.exportName ?? "renderRequest";
  const fallthroughStatuses = options.fallthroughStatuses ?? [404];
  const runtimeEnvKeys = options.runtimeEnvKeys ?? [];
  return `import * as entry from ${JSON.stringify(pathToFileURL(options.entry).href)};

const renderer = entry[${JSON.stringify(exportName)}] ?? entry.default;
const fallthroughStatuses = new Set(${JSON.stringify(fallthroughStatuses)});
const runtimeEnvKeys = ${JSON.stringify(runtimeEnvKeys)};

const runtimeEnvFor = (env) => Object.fromEntries(runtimeEnvKeys.map((key) => [key, env?.[key]]));

export default {
  async fetch(request, env = {}, ctx) {
    const assets = env && typeof env === "object" ? env.ASSETS : undefined;
    if (assets && typeof assets.fetch === "function") {
      const assetResponse = await assets.fetch(request);
      if (!fallthroughStatuses.has(assetResponse.status)) {
        return assetResponse;
      }
    }
    if (typeof renderer !== "function") {
      return new Response("Cloudflare Pages renderer export was not found.", { status: 500 });
    }
    return renderer(request, env, ctx, runtimeEnvFor(env));
  },
};
`;
};

export const packageCloudflarePages = async (
  options: CloudflarePagesPackageOptions,
): Promise<Result<CloudflarePagesPackageResult, string>> => {
  const tempDir = await mkdtemp(join(tmpdir(), "tachyon-cloudflare-pages-"));
  try {
    await rm(options.outDir, { recursive: true, force: true });
    await mkdir(options.outDir, { recursive: true });
    if (options.assetsDir) {
      await cp(options.assetsDir, options.outDir, { recursive: true, force: true });
    }
    const workerEntry = join(tempDir, "worker-entry.js");
    await writeFile(workerEntry, cloudflarePagesWorkerSource(options));
    const vite = await import("vite");
    await vite.build({
      configFile: false,
      logLevel: "silent",
      publicDir: false,
      ssr: { noExternal: true },
      build: {
        emptyOutDir: false,
        minify: false,
        outDir: options.outDir,
        sourcemap: false,
        ssr: true,
        target: "es2022",
        lib: {
          entry: workerEntry,
          formats: ["es"],
          fileName: () => "_worker.js",
        },
        rollupOptions: {
          output: {
            entryFileNames: "_worker.js",
          },
        },
      },
    });
    return ok({ outDir: options.outDir, workerPath: join(options.outDir, "_worker.js") });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const codeForTarget = (
  target: NonNullable<TachyonDomViteOptions["target"]>,
  template: Parameters<typeof generateClientModule>[0],
  reactive: boolean,
  scriptOnly: boolean,
  defaultScopeName?: string,
  hydrationBoundaryId?: string,
  hydrationChunkImports?: Readonly<Record<string, string>>,
  hydrateOnly = false,
  mountOnly = false,
  instrumentation?: { templateId: string; sourceRevision: string; mapSourceOffset: (offset: number) => number },
): string => {
  if (scriptOnly) {
    return generateScriptOnlyModule(target);
  }
  if (target === "server") {
    return generateServerModule(template, defaultScopeName ? { defaultScopeName } : {});
  }
  if (target === "stream") {
    return generateServerStreamModule(template, defaultScopeName ? { defaultScopeName } : {});
  }
  return generateClientModule(template, {
    reactive,
    instrumentBindings: instrumentation !== undefined,
    ...(defaultScopeName ? { defaultScopeName } : {}),
    ...(hydrationBoundaryId ? { hydrationBoundaryId } : {}),
    ...(hydrationChunkImports ? { hydrationChunkImports } : {}),
    ...(hydrateOnly ? { hydrateOnly: true } : {}),
    ...(mountOnly ? { mountOnly: true } : {}),
    ...instrumentation,
  });
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

const hydrationBoundaryIdFor = (id: string): string | undefined => queryForId(id).get("tachyon-hydration") ?? undefined;

/** `./Page.td?client&hydrate-only` requests a module without boundary bindings or `bind`. */
const isHydrateOnlyRequest = (id: string): boolean => queryForId(id).has("hydrate-only");

/** `./Page.td?client&mount-only` requests a module without hydration metadata or server shape matching. */
const isMountOnlyRequest = (id: string): boolean => queryForId(id).has("mount-only");

/** Declarations and type checks run once per source file, for the primary request only. */
const isPrimaryRequest = (id: string): boolean =>
  hydrationBoundaryIdFor(id) === undefined && !isHydrateOnlyRequest(id) && !isMountOnlyRequest(id);

const hydrationChunkImportsFor = (
  id: string,
  boundaries: readonly { id: string }[],
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    boundaries.map((boundary) => [
      boundary.id,
      `${cleanId(id)}?client&tachyon-hydration=${encodeURIComponent(boundary.id)}`,
    ]),
  );

const shouldIgnoreQueryRequest = (id: string): boolean => {
  const query = queryForId(id);
  return query.has("raw") || query.has("url");
};

const declarationSourceFor = (source: string, id: string): string => {
  if (!queryForId(id).has("raw") || !source.trimStart().startsWith("export default")) {
    return source;
  }
  const match = /^\s*export\s+default\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*;?\s*$/s.exec(source);
  if (!match?.[1]) return source;
  if (match[1].startsWith('"')) return JSON.parse(match[1]) as string;
  return match[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
};

const entryCodeFor = (id: string): string => {
  const moduleId = cleanId(id);
  const query = queryForId(id);
  const mountName = query.get("mount") ?? "mount";
  return [
    `import { reportHydrationDiagnostics as __tachyonReportHydrationDiagnostics } from "tachyon-dom/runtime/hydrate";`,
    `import * as module from ${JSON.stringify(moduleId)};`,
    `export * from ${JSON.stringify(moduleId)};`,
    `export default module;`,
    `const root = typeof document === "undefined" ? null : document.querySelector(${JSON.stringify(query.get("root") ?? "#app")});`,
    `const mount = module[${JSON.stringify(mountName)}] ?? module.mountApp ?? module.mountWebExample ?? module.mountAuthTodoExample ?? module.mountFullAppExample ?? module.default;`,
    `if (root instanceof HTMLElement && typeof mount === "function") {`,
    `  void mount(root);`,
    `}`,
    `const __tachyonHydrationIds = (module.hydrationBoundaries ?? []).map((boundary) => boundary && typeof boundary === "object" && boundary.idKind !== "expression" && typeof boundary.id === "string" ? boundary.id : undefined).filter((id) => typeof id === "string");`,
    `if (root instanceof HTMLElement && import.meta.hot && __tachyonHydrationIds.length > 0) {`,
    `  queueMicrotask(() => __tachyonReportHydrationDiagnostics(root, __tachyonHydrationIds, { hot: import.meta.hot }));`,
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
  let configResolved = false;
  let rootDir: string | undefined;
  return {
    name: "tachyon-dom",
    enforce: "pre",
    config(config, env) {
      // Every non-development build (production, staging, ...) is a shipping
      // build: fold diagnostics away and emit no instrumentation.
      if (env.command !== "build" || env.mode === "development") {
        return;
      }
      return {
        define: {
          ...config.define,
          __TACHYON_PRODUCTION__: "true",
        },
      };
    },
    configResolved(config) {
      command = config.command;
      mode = config.mode;
      configResolved = true;
      rootDir = typeof config.root === "string" ? config.root : undefined;
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
      if (
        include.test(cleanId(id)) &&
        !queryForId(id).has("url") &&
        !isEntryRequest(id) &&
        isPrimaryRequest(id)
      ) {
        const declarationOutput =
          options.declarationOutput === false
            ? undefined
            : typeof options.declarationOutput === "function"
              ? options.declarationOutput(cleanId(id))
              : configResolved && rootDir && (await isPathInside(rootDir, cleanId(id)))
                ? `${cleanId(id)}.d.ts`
                : undefined;
        if (declarationOutput) {
          const declarationSource = declarationSourceFor(source, id);
          const diagnostic = diagnoseTachyonSfc(declarationSource);
          if (!diagnostic.ok) {
            this.error(formatDiagnostic(diagnostic.error, cleanId(id)));
          }
          const declarations = generateTachyonModuleTypes(declarationSource);
          if (!declarations.ok) {
            this.error(declarations.error);
          }
          await mkdir(dirname(declarationOutput), { recursive: true });
          await writeFile(declarationOutput, declarations.value);
        }
      }
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
      const result = diagnoseTachyonSfc(source, {
        whitespace: options.templateWhitespace ?? "preserve",
        target: resolvedTarget,
      });
      if (!result.ok) {
        this.error(formatDiagnostic(result.error, id));
      }
      // Type checks run for every non-chunk request so a template loaded only
      // through `?client&hydrate-only` is still checked.
      if (options.typecheck === true && hydrationBoundaryIdFor(id) === undefined) {
        const typeResult = checkTachyonTemplateTypes(source, { fileName: cleanId(id) });
        if (!typeResult.ok) {
          this.error(typeResult.error);
        }
        if (typeResult.value.length > 0) {
          this.error(
            typeResult.value.map((diagnostic) => formatTemplateTypeDiagnostic(diagnostic, cleanId(id))).join("\n"),
          );
        }
      }
      const script = transformSfcScript(result.value.descriptor.script);
      if (!script.ok) {
        this.error(formatDiagnostic(diagnosticFromCompilerError(source, script.error), id));
      }
      const hydrationBoundaryId = resolvedTarget === "client" ? hydrationBoundaryIdFor(id) : undefined;
      if (
        hydrationBoundaryId !== undefined &&
        !result.value.template.client.hydrationBoundaries.some((boundary) => boundary.id === hydrationBoundaryId)
      ) {
        this.error(`Cannot generate hydration chunk for boundary ${hydrationBoundaryId}.`);
      }
      const hydrationChunkImports =
        resolvedTarget === "client" &&
        hydrationBoundaryId === undefined &&
        result.value.template.client.hydrationBoundaries.length > 0
          ? hydrationChunkImportsFor(id, result.value.template.client.hydrationBoundaries)
          : undefined;
      const hydrateOnly = resolvedTarget === "client" && hydrationBoundaryId === undefined && isHydrateOnlyRequest(id);
      const mountOnly = resolvedTarget === "client" && hydrationBoundaryId === undefined && isMountOnlyRequest(id);
      if (hydrateOnly && mountOnly) {
        throw new Error(`A Tachyon client request cannot be both hydrate-only and mount-only: ${id}`);
      }
      // Binding location instrumentation is a development aid: it names the
      // template relative to the Vite root (never an absolute path; without a
      // resolved root nothing is emitted) and is omitted from every build
      // that is not a development build.
      const instrumentation =
        resolvedTarget === "client" && (command !== "build" || mode === "development") && rootDir
          ? {
              templateId: `${relative(rootDir, cleanId(id)).split(sep).join("/")}${
                hydrationBoundaryId === undefined ? "" : `?tachyon-hydration=${hydrationBoundaryId}`
              }`,
              sourceRevision: createHash("sha256").update(source).digest("hex").slice(0, 8),
              mapSourceOffset: result.value.descriptor.mapTemplateOffset,
            }
          : undefined;
      // Boundary chunks bind with the scope resolved by the entry module, so the
      // SFC script and its setup factory are only emitted into the entry.
      const code = `${hydrationBoundaryId === undefined ? script.value.code : ""}${codeForTarget(
        resolvedTarget,
        result.value.template,
        options.reactive === true,
        result.value.scriptOnly,
        resolvedTarget === "client" && hydrationBoundaryId === undefined && script.value.defaultScopeName
          ? script.value.defaultScopeName
          : undefined,
        hydrationBoundaryId,
        hydrationChunkImports,
        hydrateOnly,
        mountOnly,
        instrumentation,
      )}`;
      const emitSourceMap = shouldEmitSourceMap({
        sourcemap: options.sourcemap,
        productionSourceMap: options.productionSourceMap,
        command,
        mode,
      });
      if (!emitSourceMap && !options.onSourceMap) {
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
  viteInternalExactPaths.includes(url.pathname) ||
  viteInternalPrefixes.some((prefix) => url.pathname.startsWith(prefix));

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

export const tachyonApp = (app: TachyonApp, options: TachyonAppViteOptions = {}): Plugin => {
  const configuredWhitespace = configuredAppHtmlWhitespace(options);
  const whitespaceFor = (mode: "development" | "production"): HtmlWhitespacePolicy =>
    configuredWhitespace ?? (mode === "development" ? "preserve-tags" : "normalize-tags");
  return {
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
        const needsClientEntry = options.clientEntry !== "when-required" || app.requiresClientEntry(page.path);
        response.end(
          app.renderDocument(page.path, {
            assets: {
              scripts: needsClientEntry ? [options.appScript ?? `${page.assetPrefix ?? "."}/main.ts`] : [],
              styles: [`${page.assetPrefix ?? "."}/styles.css`],
            },
            whitespace: whitespaceFor("development"),
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
        const needsClientEntry = options.clientEntry !== "when-required" || app.requiresClientEntry(page.path);
        const assets: TachyonAppAssets = {
          scripts: entry && entry.type === "chunk" && needsClientEntry ? [prefixed(prefix, entry.fileName)] : [],
          styles: cssFiles.map((fileName) => prefixed(prefix, fileName)),
        };
        this.emitFile({
          fileName: page.fileName,
          source: app.renderDocument(page.path, {
            assets,
            whitespace: whitespaceFor("production"),
          }),
          type: "asset",
        });
      }
    },
  };
};

export default tachyonDom;
