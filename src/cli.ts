#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateTachyonModuleTypes, generateTemplateTypes } from "./app.js";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index.js";
import { generateScriptOnlyModule, transformSfcScript } from "./compiler/sfc.js";
import { diagnoseTachyonSfc, formatDiagnostic, locateOffset } from "./diagnostics.js";
import { scanFileRoutes } from "./router-node.js";
import { appendInlineSourceMap, createSourceMap } from "./source-map.js";
import { err, ok, type Result } from "./result.js";

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
  module?: boolean;
  typeName?: string;
};

export type CliInitOptions = {
  command: "init";
  outDir: string;
  template: "basic" | "ssr";
};

export type CliLanguageServerOptions = {
  command: "language-server";
  transport: "stdio";
};

export type CliOptions =
  | CliCompileOptions
  | CliRoutesOptions
  | CliServerOptions
  | CliAddPageOptions
  | CliTypegenOptions
  | CliInitOptions
  | CliLanguageServerOptions;

const usage =
  "Usage: tachyon-dom <compile|routes|dev|build|preview|add|typegen|init|language-server>. Use compile for templates, routes for file-route manifests, dev/build/preview with Vite, add for route files, typegen for template scopes, init for starters, and language-server for editor diagnostics.";

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
    return err("Usage: tachyon-dom typegen <input> [--out file] [--type TemplateScope] [--module]");
  }
  const options: CliTypegenOptions = { command: "typegen", input, module: false };
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
    } else if (arg === "--module") {
      options.module = true;
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

const parseLanguageServerArgs = (rest: readonly string[]): Result<CliLanguageServerOptions, string> =>
  rest.length === 1 && rest[0] === "--stdio"
    ? ok({ command: "language-server", transport: "stdio" })
    : err("Usage: tachyon-dom language-server --stdio");

export const parseArgs = (argv: readonly string[]): Result<CliOptions, string> => {
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
  if (command === "language-server") {
    return parseLanguageServerArgs([input, ...rest].filter((arg): arg is string => Boolean(arg)));
  }
  return err(usage);
};

export const compileFile = async (options: Omit<CliCompileOptions, "command">): Promise<Result<string, string>> => {
  const source = await readFile(options.input, "utf8");
  const result = diagnoseTachyonSfc(source);
  if (!result.ok) {
    return err(formatDiagnostic(result.error, options.input));
  }
  const script = transformSfcScript(result.value.descriptor.script);
  if (!script.ok) {
    return err(formatDiagnostic({ ...script.error, ...locateOffset(source, script.error.offset) }, options.input));
  }
  const code = result.value.scriptOnly
    ? generateScriptOnlyModule(options.target)
    : options.target === "server"
      ? generateServerModule(result.value.template)
      : options.target === "stream"
        ? generateServerStreamModule(result.value.template)
        : generateClientModule(result.value.template, {
            reactive: options.reactive,
            ...(script.value.defaultScopeName ? { defaultScopeName: script.value.defaultScopeName } : {}),
          });
  const moduleCode = `${script.value.code}${code}`;
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
  await writeFile(
    pageFile,
    `<script>
export const scope = () => ({
  title: ${JSON.stringify(title)},
});
</script>
<section>
  <h1>{title}</h1>
</section>
`,
  );
  return ok(
    [
      `Created ${pageFile}.`,
      "Edit the generated page.td to define the route markup and scope.",
      `Run tachyon-dom typegen ${pageFile} --out ${pageFile}.ts --module if you want generated scope declarations.`,
      "Register the route through your app definition or file-route collection.",
    ].join("\n"),
  );
};

export const generateTemplateTypesFile = async (
  options: Omit<CliTypegenOptions, "command">,
): Promise<Result<string, string>> => {
  const source = await readFile(options.input, "utf8");
  const result = options.module === true
    ? generateTachyonModuleTypes(source, options.typeName ? { typeName: options.typeName } : {})
    : generateTemplateTypes(source, options.typeName ? { typeName: options.typeName } : {});
  if (!result.ok) {
    return result;
  }
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, result.value);
  }
  return result;
};

const starterPageSource = (): string => `<script>
export const scope = () => ({
  message: "Edit src/routes/index/page.td to start building.",
  title: "Welcome",
});
</script>
<section>
  <h1>{title}</h1>
  <p>{message}</p>
</section>
`;

const starterAppSource = (): string => `import { defineApp } from "tachyon-dom/app";
import pageTemplate from "./routes/index/page.td?raw";

export const app = defineApp({
  lang: "en",
  title: "Tachyon App",
  pages: [
    {
      assetPrefix: ".",
      fileName: "index.html",
      path: "/",
      scope: {
        message: "Edit src/routes/index/page.td to start building.",
        title: "Welcome",
      },
      template: pageTemplate,
    },
  ],
});
`;

const starterClientSource = (): string => `// Client entry for Tachyon DOM runtime code.
// Add progressive enhancements, client routing, or island hydration imports here.
`;

const starterViteConfigSource = (): string => `import { defineConfig } from "vite";
import { app } from "./src/app";
import { tachyonApp, tachyonDom } from "tachyon-dom/vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: "src/client/main.ts",
    },
  },
  plugins: [tachyonDom({ reactive: true }), tachyonApp(app, { appScript: "/src/client/main.ts" })],
});
`;

const starterTsConfigSource = (): string =>
  `${JSON.stringify(
    {
      compilerOptions: {
        exactOptionalPropertyTypes: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
        types: ["vite/client"],
      },
      include: ["src", "vite.config.ts"],
    },
    null,
    2,
  )}\n`;

const starterReadmeSource = (template: CliInitOptions["template"]): string => `# Tachyon DOM Starter

Edit \`src/routes/index/page.td\` to start building. Route-local \`.td\` files are the source of truth for page markup.

Use \`src/client/main.ts\` for client-side runtime code that should be bundled by Vite. Do not put application code in \`public/client/main.js\`; reserve \`public/\` for static assets such as images, icons, manifests, and service workers.

Run:

\`\`\`sh
pnpm install
pnpm dev
pnpm typecheck
pnpm build
\`\`\`

Add a page with:

\`\`\`sh
tachyon-dom add page settings/profile
\`\`\`

Adapters are lower-level deployment APIs for Node, Workers, and Lambda composition. A standard Tachyon DOM app should keep \`.td\` templates and the Vite plugins on the main development path.

Template: \`${template}\`. The \`ssr\` starter currently uses the same Vite SSR shape as \`basic\`.
`;

const starterPackageJsonSource = (): string =>
  `${JSON.stringify(
    {
      scripts: {
        build: "vite build",
        dev: "vite",
        preview: "vite preview",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        "tachyon-dom": "^0.1.0",
      },
      devDependencies: {
        typescript: "^5.8.3",
        vite: "^8.0.0",
      },
      type: "module",
    },
    null,
    2,
  )}\n`;

export const createStarterFiles = async (options: Omit<CliInitOptions, "command">): Promise<Result<string, string>> => {
  await mkdir(join(options.outDir, "src", "routes", "index"), { recursive: true });
  await mkdir(join(options.outDir, "src", "client"), { recursive: true });
  await writeFile(join(options.outDir, "src", "routes", "index", "page.td"), starterPageSource());
  await writeFile(join(options.outDir, "src", "app.ts"), starterAppSource());
  await writeFile(join(options.outDir, "src", "client", "main.ts"), starterClientSource());
  await writeFile(join(options.outDir, "vite.config.ts"), starterViteConfigSource());
  await writeFile(join(options.outDir, "tsconfig.json"), starterTsConfigSource());
  await writeFile(join(options.outDir, "README.md"), starterReadmeSource(options.template));
  await writeFile(join(options.outDir, "package.json"), starterPackageJsonSource());
  const templateNote =
    options.template === "ssr" ? " The ssr starter currently uses the same Vite SSR shape as basic." : "";
  return ok(
    `Created Tachyon DOM starter in ${options.outDir}. Edit src/routes/index/page.td to start building.${templateNote}`,
  );
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
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(usage);
    return 0;
  }
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  let result: Result<string, string>;
  switch (parsed.value.command) {
    case "language-server": {
      const { startLanguageServer } = await import("./language-server.js");
      startLanguageServer();
      return 0;
    }
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

export const isCliEntrypoint = async (
  scriptPath: string | undefined = process.argv[1],
  moduleUrl = import.meta.url,
): Promise<boolean> => {
  if (!scriptPath) {
    return false;
  }
  try {
    return pathToFileURL(await realpath(scriptPath)).href === moduleUrl;
  } catch {
    return scriptPath.endsWith("cli.js") && moduleUrl.endsWith("/cli.js");
  }
};

if (await isCliEntrypoint()) {
  process.exitCode = await runCli();
}
