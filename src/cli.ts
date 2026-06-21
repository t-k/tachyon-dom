#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateTemplateTypes } from "./app";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index";
import { sfcDefaultScopeName, transformSfcScript } from "./compiler/sfc";
import { diagnoseTachyonSfc, formatDiagnostic } from "./diagnostics";
import { scanFileRoutes } from "./router";
import { appendInlineSourceMap, createSourceMap } from "./source-map";
import { err, ok, type Result } from "./result";

export type CliCompileOptions = {
  command: "compile";
  input: string;
  output?: string;
  target: "client" | "server" | "stream";
  reactive: boolean;
  sourcemap: boolean;
};

export type CliRoutesOptions = {
  command: "routes";
  routesDir: string;
  output?: string;
};

export type CliServerOptions = {
  command: "dev" | "preview" | "build";
  host: string;
  port: number;
};

export type CliAddPageOptions = {
  command: "add-page";
  name: string;
  routesDir: string;
};

export type CliTypegenOptions = {
  command: "typegen";
  input: string;
  output?: string;
  typeName?: string;
};

export type CliInitOptions = {
  command: "init";
  outDir: string;
  template: "basic" | "ssr";
};

export type CliOptions =
  | CliCompileOptions
  | CliRoutesOptions
  | CliServerOptions
  | CliAddPageOptions
  | CliTypegenOptions
  | CliInitOptions;

const parseCompileArgs = (input: string, rest: readonly string[]): Result<CliCompileOptions, string> => {
  if (!input) {
    return err(
      "Usage: tachyon-dom compile <input> [--target client|server|stream] [--out file] [--reactive] [--no-sourcemap]",
    );
  }
  const options: CliCompileOptions = {
    command: "compile",
    input,
    target: "client",
    reactive: false,
    sourcemap: true,
  };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--target") {
      const target = rest[++index];
      if (target !== "client" && target !== "server" && target !== "stream") {
        return err("--target must be client, server, or stream.");
      }
      options.target = target;
    } else if (arg === "--out") {
      const output = rest[++index];
      if (!output) {
        return err("--out requires a file path.");
      }
      options.output = output;
    } else if (arg === "--reactive") {
      options.reactive = true;
    } else if (arg === "--no-sourcemap") {
      options.sourcemap = false;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseRoutesArgs = (routesDir: string, rest: readonly string[]): Result<CliRoutesOptions, string> => {
  if (!routesDir) {
    return err("Usage: tachyon-dom routes <routes-dir> [--out route-manifest.json]");
  }
  const options: CliRoutesOptions = { command: "routes", routesDir };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--out") {
      const output = rest[++index];
      if (!output) {
        return err("--out requires a file path.");
      }
      options.output = output;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseServerArgs = (
  command: "dev" | "preview" | "build",
  rest: readonly string[],
): Result<CliServerOptions, string> => {
  const options: CliServerOptions = { command, host: "127.0.0.1", port: command === "dev" ? 5173 : 4173 };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--host") {
      const host = rest[++index];
      if (!host) {
        return err("--host requires a value.");
      }
      options.host = host;
    } else if (arg === "--port") {
      const port = Number.parseInt(rest[++index] ?? "", 10);
      if (!Number.isFinite(port)) {
        return err("--port requires a number.");
      }
      options.port = port;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseAddArgs = (kind: string, name: string, rest: readonly string[]): Result<CliAddPageOptions, string> => {
  if (kind !== "page" || !name) {
    return err("Usage: tachyon-dom add page <name> [--routes-dir src/routes]");
  }
  const options: CliAddPageOptions = { command: "add-page", name, routesDir: "src/routes" };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--routes-dir") {
      const routesDir = rest[++index];
      if (!routesDir) {
        return err("--routes-dir requires a path.");
      }
      options.routesDir = routesDir;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseTypegenArgs = (input: string, rest: readonly string[]): Result<CliTypegenOptions, string> => {
  if (!input) {
    return err("Usage: tachyon-dom typegen <input> [--out file] [--type TemplateScope]");
  }
  const options: CliTypegenOptions = { command: "typegen", input };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--out") {
      const output = rest[++index];
      if (!output) {
        return err("--out requires a file path.");
      }
      options.output = output;
    } else if (arg === "--type") {
      const typeName = rest[++index];
      if (!typeName) {
        return err("--type requires a type name.");
      }
      options.typeName = typeName;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseInitArgs = (rest: readonly string[]): Result<CliInitOptions, string> => {
  const options: CliInitOptions = { command: "init", outDir: ".", template: "basic" };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--out") {
      const outDir = rest[++index];
      if (!outDir) {
        return err("--out requires a directory.");
      }
      options.outDir = outDir;
    } else if (arg === "--template") {
      const template = rest[++index];
      if (template !== "basic" && template !== "ssr") {
        return err("--template must be basic or ssr.");
      }
      options.template = template;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseArgs = (argv: readonly string[]): Result<CliOptions, string> => {
  const [command, input, ...rest] = argv;
  if (command === "compile") {
    return parseCompileArgs(input ?? "", rest);
  }
  if (command === "routes") {
    return parseRoutesArgs(input ?? "", rest);
  }
  if (command === "dev" || command === "preview" || command === "build") {
    return parseServerArgs(
      command,
      [input, ...rest].filter((arg): arg is string => Boolean(arg)),
    );
  }
  if (command === "add") {
    return parseAddArgs(input ?? "", rest[0] ?? "", rest.slice(1));
  }
  if (command === "typegen") {
    return parseTypegenArgs(input ?? "", rest);
  }
  if (command === "init") {
    return parseInitArgs([input, ...rest].filter((arg): arg is string => Boolean(arg)));
  }
  return err(
    "Usage: tachyon-dom <compile|routes|dev|build|preview|add|typegen|init>. Use compile for templates, routes for file-route manifests, dev/build/preview with Vite, add for route files, typegen for template scopes, and init for starters.",
  );
};

export const compileFile = async (options: Omit<CliCompileOptions, "command">): Promise<Result<string, string>> => {
  const source = await readFile(options.input, "utf8");
  const result = diagnoseTachyonSfc(source);
  if (!result.ok) {
    return err(formatDiagnostic(result.error, options.input));
  }
  const script = transformSfcScript(result.value.descriptor.script);
  const code =
    options.target === "server"
      ? generateServerModule(result.value.template)
      : options.target === "stream"
        ? generateServerStreamModule(result.value.template)
        : generateClientModule(result.value.template, {
            reactive: options.reactive,
            ...(script.defaultScopeName ? { defaultScopeName: sfcDefaultScopeName } : {}),
          });
  const moduleCode = `${script.code}${code}`;
  const output = options.sourcemap
    ? appendInlineSourceMap(moduleCode, createSourceMap(source, options.input, options.output))
    : moduleCode;
  if (options.output) {
    await writeFile(options.output, output);
  }
  return ok(output);
};

export const buildRouteManifestFile = async (
  options: Omit<CliRoutesOptions, "command">,
): Promise<Result<string, string>> => {
  const manifest = await scanFileRoutes(options.routesDir);
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, output);
  }
  return ok(output);
};

const titleCase = (value: string): string =>
  value
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

export const addPageFiles = async (options: Omit<CliAddPageOptions, "command">): Promise<Result<string, string>> => {
  const normalized = options.name.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..")) {
    return err("Page name must be a route-local path without '..'.");
  }
  const targetDir = join(options.routesDir, normalized);
  const title = titleCase(normalized);
  await mkdir(targetDir, { recursive: true });
  const pageFile = join(targetDir, "page.td");
  const routeFile = join(targetDir, "route.ts");
  await writeFile(pageFile, `<section>\n  <h1>{title}</h1>\n</section>\n`);
  await writeFile(routeFile, `export const scope = () => ({\n  title: ${JSON.stringify(title)},\n});\n`);
  return ok([pageFile, routeFile].join("\n"));
};

export const generateTemplateTypesFile = async (
  options: Omit<CliTypegenOptions, "command">,
): Promise<Result<string, string>> => {
  const source = await readFile(options.input, "utf8");
  const result = generateTemplateTypes(source, options.typeName ? { typeName: options.typeName } : {});
  if (!result.ok) {
    return result;
  }
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, result.value);
  }
  return result;
};

export const createStarterFiles = async (options: Omit<CliInitOptions, "command">): Promise<Result<string, string>> => {
  await mkdir(join(options.outDir, "src", "routes", "index"), { recursive: true });
  await writeFile(
    join(options.outDir, "src", "routes", "index", "page.td"),
    `<section>\n  <h1>{title}</h1>\n  <p>{message}</p>\n</section>\n`,
  );
  await writeFile(
    join(options.outDir, "src", "routes", "index", "route.ts"),
    `export const scope = () => ({\n  message: "Edit src/routes/index/page.td to start building.",\n  title: "Welcome",\n});\n`,
  );
  await writeFile(
    join(options.outDir, "src", "main.ts"),
    `import { defineApp } from "tachyon-dom/app";\n\nexport const app = defineApp({\n  pages: [\n    {\n      assetPrefix: ".",\n      fileName: "index.html",\n      path: "/",\n      scope: { message: "Edit src/routes/index/page.td to start building.", title: "Welcome" },\n      template: "<section><h1>{title}</h1><p>{message}</p></section>",\n    },\n  ],\n});\n`,
  );
  await writeFile(
    join(options.outDir, "vite.config.ts"),
    `import { defineConfig } from "vite";\nimport { app } from "./src/main";\nimport { tachyonApp, tachyonDom } from "tachyon-dom/vite";\n\nexport default defineConfig({\n  plugins: [tachyonDom({ reactive: true }), tachyonApp(app)],\n});\n`,
  );
  await writeFile(
    join(options.outDir, "package.json"),
    `${JSON.stringify({ scripts: { build: "vite build", dev: "vite" }, type: "module" }, null, 2)}\n`,
  );
  return ok(options.outDir);
};

export const serverCommandMessage = (options: CliServerOptions): string =>
  options.command === "build"
    ? "Build the tachyon-dom app with Vite."
    : options.command === "dev"
      ? `Start Vite dev server with tachyon-dom plugin on ${options.host}:${options.port}.`
      : `Start Vite preview server for the built tachyon-dom app on ${options.host}:${options.port}.`;

const startViteServer = async (options: CliServerOptions): Promise<Result<string, string>> => {
  const vite = await import("vite");
  if (options.command === "build") {
    await vite.build();
    return ok(serverCommandMessage(options));
  }
  const server =
    options.command === "dev"
      ? await vite.createServer({
          server: { host: options.host, port: options.port },
        })
      : await vite.preview({
          preview: { host: options.host, port: options.port },
        });
  if ("listen" in server && typeof server.listen === "function") {
    await server.listen();
  }
  const urls = "resolvedUrls" in server ? server.resolvedUrls?.local : undefined;
  return ok(urls?.join("\n") ?? serverCommandMessage(options));
};

export const runCli = async (argv: readonly string[] = process.argv.slice(2)): Promise<number> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  let result: Result<string, string>;
  switch (parsed.value.command) {
    case "dev":
    case "build":
    case "preview":
      result = await startViteServer(parsed.value);
      break;
    case "init":
      result = await createStarterFiles(parsed.value);
      break;
    case "add-page":
      result = await addPageFiles(parsed.value);
      break;
    case "typegen":
      result = await generateTemplateTypesFile(parsed.value);
      break;
    case "compile":
      result = await compileFile(parsed.value);
      break;
    case "routes":
      result = await buildRouteManifestFile({
        routesDir: parsed.value.routesDir,
        ...(parsed.value.output ? { output: parsed.value.output } : {}),
      });
      break;
  }
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  if (!("output" in parsed.value) || !parsed.value.output) {
    console.log(result.value);
  }
  return 0;
};

if (process.argv[1]?.endsWith("cli.js")) {
  process.exitCode = await runCli();
}
