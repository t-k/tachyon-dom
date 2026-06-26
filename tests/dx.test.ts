import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createServer } from "vite";
import {
  addPageFiles,
  buildRouteManifestFile,
  createStarterFiles,
  compileFile,
  generateTemplateTypesFile,
  isCliEntrypoint,
  parseArgs,
  runCli,
  serverCommandMessage,
} from "../src/cli";
import { defineApp, generateTemplateTypes, pagesFromRouteFiles, renderAppDocument } from "../src/app";
import { diagnoseTemplate, formatDiagnostic } from "../src/diagnostics";
import { appendInlineSourceMap, createSourceMap, shouldEmitSourceMap } from "../src/source-map";
import { defineTemplate, templateScope, type TypedTemplate } from "../src/typed";
import { tachyonApp, tachyonDom, tachyonDomRoutes } from "../src/vite";

type PanelScope = {
  title: string;
  count: number;
};

const collectTypeScriptFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTypeScriptFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return files.flat();
};

const collectRelativeModuleSpecifiers = (sourceFile: ts.SourceFile): string[] => {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(".")
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
        specifiers.push(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

describe("DX helpers", () => {
  it("formats compiler diagnostics with line and column", () => {
    const result = diagnoseTemplate(`<main>\n<if></if>\n</main>`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected diagnostic.");
    }
    expect(result.error).toMatchObject({
      message: "<if> requires test={condition}.",
      line: 1,
      column: 1,
    });
    expect(formatDiagnostic(result.error, "bad.tachyon.html")).toContain(
      "bad.tachyon.html:1:1: <if> requires test={condition}.",
    );
  });

  it("appends an inline source map with sourcesContent", () => {
    const output = appendInlineSourceMap(
      "export const value = 1;\n",
      createSourceMap("<main></main>", "view.tachyon.html"),
    );
    const encoded = output.split("base64,")[1]?.trim();
    if (!encoded) {
      throw new Error("Missing source map.");
    }
    const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { sourcesContent: string[] };

    expect(map.sourcesContent).toEqual(["<main></main>"]);
  });

  it("keeps template scope types available to TypeScript users", () => {
    const typed = defineTemplate<PanelScope, `<h1>{title}</h1>`>(`<h1>{title}</h1>`);
    const scoped = templateScope<PanelScope>().define(`<button>{count}</button>`);

    expect(typed satisfies TypedTemplate<PanelScope>).toEqual({ source: `<h1>{title}</h1>` });
    expect(scoped.source).toBe(`<button>{count}</button>`);
  });

  it("marks the package as tree-shakable for bundlers", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      sideEffects?: boolean;
      exports?: Record<string, unknown>;
    };

    expect(packageJson.sideEffects).toBe(false);
    expect(packageJson.exports).toHaveProperty("./runtime/list");
    expect(packageJson.exports).toHaveProperty("./router");
  });

  it("declares npm release metadata for public package discovery", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      description?: string;
      repository?: { type?: string; url?: string };
      keywords?: string[];
      engines?: { node?: string };
      publishConfig?: { access?: string };
    };

    expect(packageJson.description).toBe("A small TypeScript UI runtime and HTML-first compiler.");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "https://github.com/t-k/tachyon-dom.git",
    });
    expect(packageJson.keywords).toEqual(["ui", "runtime", "compiler", "templates", "ssr"]);
    expect(packageJson.engines?.node).toBe(">=24");
    expect(packageJson.publishConfig).toEqual({ access: "public" });
  });

  it("keeps example build output outside the published dist directory", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = packageJson.scripts?.["example:hacker-news:build"] ?? "";

    expect(script).toContain("--outdir examples/hacker-news/dist/worker");
    expect(script).not.toContain("--outdir dist/");
  });

  it("uses Node ESM-compatible relative module specifiers in emitted source files", async () => {
    const files = await collectTypeScriptFiles(path.join(process.cwd(), "src"));
    const extensionlessSpecifiers: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const specifier of collectRelativeModuleSpecifiers(sourceFile)) {
        if (!path.extname(specifier)) {
          extensionlessSpecifiers.push(`${path.relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(extensionlessSpecifiers).toEqual([]);
  });

  it("compiles template files through the CLI helper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-"));
    try {
      const input = path.join(dir, "view.td");
      const output = path.join(dir, "view.js");
      await writeFile(input, `<main>{title}</main>`);

      const result = await compileFile({ input, output, target: "client", reactive: false, sourcemap: true });

      expect(result.ok).toBe(true);
      expect(await readFile(output, "utf8")).toContain(`export const templateHtml = "<main> </main>";`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compiles .td files with colocated script logic through the CLI helper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-sfc-"));
    try {
      const input = path.join(dir, "counter.td");
      const output = path.join(dir, "counter.js");
      await writeFile(
        input,
        `<script>
export const pageTitle = "Counter";
export default () => ({
  count: 1,
  increment: () => undefined,
});
</script>
<button on:click={increment}>{count}</button>`,
      );

      const result = await compileFile({ input, output, target: "client", reactive: true, sourcemap: false });

      expect(result.ok).toBe(true);
      const code = await readFile(output, "utf8");
      expect(code).toContain(`export const pageTitle = "Counter";`);
      expect(code).toContain(`const __tachyonSfcDefaultScope = () => ({`);
      expect(code).toContain(`export { __tachyonSfcDefaultScope as default };`);
      expect(code).toContain(`const scope = __tachyonCreateScope(inputScope);`);
      expect(code).toContain(`export const templateHtml = "<button> </button>";`);
      expect(code).toContain(`scope.increment`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses named SFC scope exports as the page scope factory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-sfc-scope-"));
    try {
      const input = path.join(dir, "counter.td");
      const output = path.join(dir, "counter.js");
      await writeFile(
        input,
        `<script>
export const scope = () => ({
  count: 1,
  increment: () => undefined,
});
</script>
<button on:click={increment}>{count}</button>`,
      );

      const result = await compileFile({ input, output, target: "client", reactive: true, sourcemap: false });

      expect(result.ok).toBe(true);
      const code = await readFile(output, "utf8");
      expect(code).toContain(`const __tachyonSfcScope = () => ({`);
      expect(code).toContain(`export { __tachyonSfcScope as scope };`);
      expect(code).toContain(`typeof __tachyonSfcScope === "function"`);
      expect(code).toContain(`cleanups.push(__tachyonDelegate(root, "click", [], scope.increment));`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compiles script-only .td modules without requiring a template root", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-sfc-script-only-"));
    try {
      const input = path.join(dir, "app.td");
      const output = path.join(dir, "app.js");
      await writeFile(
        input,
        `<script>
export const createMessage = (name) => "Hello " + name;
</script>`,
      );

      const result = await compileFile({ input, output, target: "client", reactive: true, sourcemap: false });

      expect(result.ok).toBe(true);
      const code = await readFile(output, "utf8");
      expect(code).toContain(`export const createMessage = (name) => "Hello " + name;`);
      expect(code).toContain(`export const templateHtml = "";`);
      expect(code).toContain(`export const bind = () => undefined;`);
      expect(code).not.toContain(`tachyon-dom/runtime/`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compiles TypeScript SFC scripts and preserves typed module declarations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-sfc-ts-"));
    try {
      const input = path.join(dir, "app.td");
      const output = path.join(dir, "app.js");
      const types = path.join(dir, "app.td.d.ts");
      await writeFile(
        input,
        `<script lang="ts">
export type AppState = { count: number };
export const mount = (root: HTMLElement, state: AppState): void => {
  root.textContent = String(state.count);
};
export const scope = (input: Partial<AppState> = {}) => ({
  count: input.count ?? 1,
});
</script>
<button>{count}</button>`,
      );

      const compiled = await compileFile({ input, output, target: "client", reactive: true, sourcemap: false });
      const generatedTypes = await generateTemplateTypesFile({
        input,
        module: true,
        output: types,
        typeName: "AppTemplateScope",
      });

      expect(compiled.ok).toBe(true);
      const code = await readFile(output, "utf8");
      expect(code).toContain(`export const mount = (root, state) => {`);
      expect(code).toContain(`const __tachyonSfcScope = (input = {}) => ({`);
      expect(code).not.toContain(`AppState`);

      expect(generatedTypes.ok).toBe(true);
      const dts = await readFile(types, "utf8");
      expect(dts).toContain(`export type AppState = {`);
      expect(dts).toContain(`export declare const mount:`);
      expect(dts).toContain(`export type AppTemplateScope = {`);
      expect(dts).toContain(`export declare const bind:`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports script setup bindings and auto-imported Tachyon helpers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-sfc-setup-"));
    try {
      const input = path.join(dir, "counter.td");
      const output = path.join(dir, "counter.js");
      await writeFile(
        input,
        `<script setup lang="ts">
const count = createSignal(1);
const increment = (): void => {
  count.set(count() + 1);
};
</script>
<button on:click={increment}>{count}</button>`,
      );

      const result = await compileFile({ input, output, target: "client", reactive: true, sourcemap: false });

      expect(result.ok).toBe(true);
      const code = await readFile(output, "utf8");
      expect(code).toContain(`import { createSignal } from "tachyon-dom";`);
      expect(code).toContain(`const __tachyonSfcSetupScope = { count: count, increment: increment };`);
      expect(code).toContain(`typeof __tachyonSfcSetupScope === "function"`);
      expect(code).toContain(`scope.increment`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds a file route manifest through the CLI helper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-routes-"));
    try {
      const routesDir = path.join(dir, "routes");
      const output = path.join(dir, "route-manifest.json");
      await mkdir(path.join(routesDir, "users"), { recursive: true });
      await writeFile(path.join(routesDir, "index.td"), `<main>Home</main>`);
      await writeFile(path.join(routesDir, "users", "[id].td"), `<main>User</main>`);

      const result = await buildRouteManifestFile({ routesDir, output });

      expect(result.ok).toBe(true);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual([
        { id: "index", path: "/", file: path.join(routesDir, "index.td"), kind: "template" },
        {
          id: "users-id",
          path: "/users/:id",
          file: path.join(routesDir, "users", "[id].td"),
          kind: "template",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defines an SSR app from page templates without hand-written entry files", () => {
    const app = defineApp({
      title: "Docs",
      pages: [
        {
          path: "/",
          fileName: "index.html",
          template: `<section><h1>{title}</h1></section>`,
          scope: { title: "Home" },
        },
        {
          path: "/counter/",
          fileName: "counter/index.html",
          template: `<section><h1>{title}</h1><p>{count}</p></section>`,
          scope: { count: 1, title: "Counter" },
        },
      ],
      shell: ({ routeHtml }) => `<main id="app">${routeHtml}</main>`,
    });

    expect(renderAppDocument(app, "/counter/")).toContain(
      `<main id="app"><section><h1>Counter</h1><p>1</p></section></main>`,
    );
    expect(app.entries({ minify: true }).map((entry) => entry.fileName)).toEqual(["index.html", "counter/index.html"]);
    expect(app.entries({ minify: true })[1]?.source).not.toContain("\n  <");
  });

  it("creates page definitions from route-local template files", () => {
    const pages = pagesFromRouteFiles(
      ["/repo/src/routes/index/page.td", "/repo/src/routes/counter/page.td", "/repo/src/routes/blog/[...slug]/page.td"],
      {
        rootDir: "/repo/src/routes",
      },
    );

    expect(pages).toEqual([
      { assetPrefix: ".", file: "/repo/src/routes/index/page.td", fileName: "index.html", path: "/" },
      {
        assetPrefix: "..",
        file: "/repo/src/routes/counter/page.td",
        fileName: "counter/index.html",
        path: "/counter/",
      },
      {
        assetPrefix: "../..",
        file: "/repo/src/routes/blog/[...slug]/page.td",
        fileName: "blog/[...slug]/index.html",
        path: "/blog/*slug/",
      },
    ]);
  });

  it("generates scope types from template bindings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-typegen-"));
    try {
      const input = path.join(dir, "page.td");
      const output = path.join(dir, "page.td.ts");
      await writeFile(
        input,
        `<script>
export default { selected: false };
</script>
<button on:click={increment} class:active={selected}>{count}</button>`,
      );

      const inline = generateTemplateTypes(`<main>{title}</main>`, { typeName: "HomeScope" });
      const result = await generateTemplateTypesFile({ input, output, typeName: "CounterScope" });

      expect(inline.ok && inline.value).toContain("export type HomeScope");
      expect(result.ok).toBe(true);
      expect(await readFile(output, "utf8")).toContain("increment: unknown;");
      expect(await readFile(output, "utf8")).toContain("selected: unknown;");
      expect(await readFile(output, "utf8")).toContain("count: unknown;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds route-local page files through the CLI helper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-add-page-"));
    try {
      const routesDir = path.join(dir, "src", "routes");
      const result = await addPageFiles({ name: "settings/profile", routesDir });

      expect(result.ok).toBe(true);
      expect(await readFile(path.join(routesDir, "settings", "profile", "page.td"), "utf8")).toContain(
        "<h1>{title}</h1>",
      );
      expect(await readFile(path.join(routesDir, "settings", "profile", "page.td"), "utf8")).toContain(
        `title: "Settings Profile"`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates starter files for new apps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-starter-"));
    try {
      const result = await createStarterFiles({ outDir: dir, template: "basic" });

      expect(result.ok).toBe(true);
      expect(await readFile(path.join(dir, "src", "routes", "index", "page.td"), "utf8")).toContain("<h1>{title}</h1>");
      expect(await readFile(path.join(dir, "src", "routes", "index", "page.td"), "utf8")).toContain("Welcome");
      expect(await readFile(path.join(dir, "vite.config.ts"), "utf8")).toContain("tachyonApp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("describes real dev and preview CLI commands", () => {
    expect(serverCommandMessage({ command: "dev", host: "127.0.0.1", port: 5173 })).toContain("Vite dev server");
    expect(serverCommandMessage({ command: "preview", host: "127.0.0.1", port: 4173 })).toContain(
      "Vite preview server",
    );
  });

  it("prints CLI help successfully", async () => {
    await expect(runCli(["--help"])).resolves.toBe(0);
  });

  it("detects CLI entrypoints through npm bin symlinks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-bin-"));
    try {
      const target = path.join(dir, "dist", "cli.js");
      const link = path.join(dir, "node_modules", ".bin", "tachyon-dom");
      await mkdir(path.dirname(target), { recursive: true });
      await mkdir(path.dirname(link), { recursive: true });
      await writeFile(target, "");
      await symlink(target, link);

      await expect(isCliEntrypoint(link, pathToFileURL(target).href)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses language server stdio commands", () => {
    expect(parseArgs(["language-server", "--stdio"])).toEqual({
      ok: true,
      value: { command: "language-server", transport: "stdio" },
    });
    expect(parseArgs(["language-server"])).toEqual({
      ok: false,
      error: "Usage: tachyon-dom language-server --stdio",
    });
  });

  it("transforms tachyon html files through the Vite plugin", async () => {
    const plugin = tachyonDom({ reactive: true });
    if (typeof plugin.transform !== "function") {
      throw new Error("Missing transform hook.");
    }

    const result = await plugin.transform.call(
      {
        error(error: string): never {
          throw new Error(error);
        },
      } as never,
      `<button>{label}</button>`,
      "/src/button.td",
    );

    expect(result).toMatchObject({
      map: null,
    });
    expect(typeof result === "object" && result?.code).toContain(`from "tachyon-dom/runtime/signal"`);
    expect(typeof result === "object" && result?.code).toContain(`sourceMappingURL=data:application/json;base64`);
  });

  it("transforms .td SFC script blocks through the Vite plugin", async () => {
    const plugin = tachyonDom({ reactive: true });
    if (typeof plugin.transform !== "function") {
      throw new Error("Missing transform hook.");
    }

    const result = await plugin.transform.call(
      {
        error(error: string): never {
          throw new Error(error);
        },
      } as never,
      `<script>
export const pageTitle = "Counter";
export default {
  count: 1,
  increment: () => undefined,
};
</script>
<button on:click={increment}>{count}</button>`,
      "/src/counter.td",
    );

    const code = typeof result === "object" ? result?.code : undefined;
    expect(code).toContain(`export const pageTitle = "Counter";`);
    expect(code).toContain(`const __tachyonSfcDefaultScope = {`);
    expect(code).toContain(`const scope = __tachyonCreateScope(inputScope);`);
    expect(code).toContain(`cleanups.push(__tachyonDelegate(root, "click", [], scope.increment));`);
  });

  it("aliases generated runtime imports so SFC scripts can use named runtime imports", async () => {
    const plugin = tachyonDom({ reactive: true });
    if (typeof plugin.transform !== "function") {
      throw new Error("Missing transform hook.");
    }

    const result = await plugin.transform.call(
      {
        error(error: string): never {
          throw new Error(error);
        },
      } as never,
      `<script>
import { mountKeyedList } from "tachyon-dom/runtime/list";
import { effect } from "tachyon-dom/runtime/signal";

export const bindRows = (root, rows, options) => effect(() => {
  mountKeyedList(root, [], rows(), options);
});
</script>
<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`,
      "/src/rows.td",
    );

    const code = typeof result === "object" ? result?.code : "";
    expect(code).toContain(`import { mountKeyedList } from "tachyon-dom/runtime/list";`);
    expect(code).toContain(`import { effect } from "tachyon-dom/runtime/signal";`);
    expect(code).toContain(`import { mountKeyedList as __tachyonMountKeyedList } from "tachyon-dom/runtime/list";`);
    expect(code).toContain(
      `import { effect as __tachyonEffect, read as __tachyonRead } from "tachyon-dom/runtime/signal";`,
    );
    expect(code).toContain(`__tachyonMountKeyedList(root, [], __tachyonRead(scope.rows)`);
  });

  it("transforms target-specific .td query modules", async () => {
    const plugin = tachyonDom({ reactive: true });
    if (typeof plugin.transform !== "function") {
      throw new Error("Missing transform hook.");
    }
    const context = {
      error(error: string): never {
        throw new Error(error);
      },
    } as never;

    const server = await plugin.transform.call(context, `<main>{title}</main>`, "/src/page.td?server");
    const stream = await plugin.transform.call(context, `<main>{title}</main>`, "/src/page.td?stream");
    const client = await plugin.transform.call(context, `<main>{title}</main>`, "/src/page.td?client");

    expect(typeof server === "object" && server?.code).toContain(`export const render = (scope) =>`);
    expect(typeof stream === "object" && stream?.code).toContain(`export const stream = async function*`);
    expect(typeof client === "object" && client?.code).toContain(`export const bind = (root, scope) =>`);
  });

  it("loads .td entry modules that auto-mount exported mount functions", async () => {
    const plugin = tachyonDom({ reactive: true });
    if (typeof plugin.load !== "function") {
      throw new Error("Missing load hook.");
    }

    const code = await plugin.load.call({} as never, "/src/app.td?entry&mount=start&root=%23root", {} as never);

    expect(code).toContain(`import * as module from "/src/app.td";`);
    expect(code).toContain(`document.querySelector("#root")`);
    expect(code).toContain(`module["start"]`);
    expect(code).toContain(`void mount(root);`);
  });

  it("logs dev server requests from the Vite plugin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-vite-log-"));
    const logs: string[] = [];
    const server = await createServer({
      root: dir,
      logLevel: "silent",
      plugins: [
        tachyonDom({
          requestLog: {
            logger: (message) => logs.push(message),
          },
        }),
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
      },
    });
    try {
      await writeFile(path.join(dir, "index.html"), `<main>ok</main>`);
      await server.listen();
      const localUrl = server.resolvedUrls?.local.find((url) => url.startsWith("http://127.0.0.1"));
      if (!localUrl) {
        throw new Error("Missing Vite local URL.");
      }

      const response = await fetch(`${localUrl}?token=secret`);
      await response.text();

      expect(logs.some((line) => /^GET \/ 200 \d+ms$/.test(line))).toBe(true);
      expect(logs.some((line) => line.includes("secret"))).toBe(false);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves SSR app HTML through the Vite app preset", async () => {
    const app = defineApp({
      pages: [
        {
          path: "/",
          fileName: "index.html",
          template: `<section><h1>{title}</h1></section>`,
          scope: { title: "Home" },
        },
      ],
    });
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-vite-app-"));
    const server = await createServer({
      root: dir,
      logLevel: "silent",
      plugins: [tachyonApp(app)],
      server: {
        host: "127.0.0.1",
        port: 0,
      },
    });
    try {
      await server.listen();
      const localUrl = server.resolvedUrls?.local.find((url) => url.startsWith("http://127.0.0.1"));
      if (!localUrl) {
        throw new Error("Missing Vite local URL.");
      }

      const response = await fetch(localUrl);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("<h1>Home</h1>");
      expect(html).toContain('<main id="app">');
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can disable production source maps and expose artifacts for upload hooks", async () => {
    const uploaded: string[] = [];
    const plugin = tachyonDom({
      productionSourceMap: false,
      onSourceMap: ({ id }) => {
        uploaded.push(id);
      },
    });
    if (typeof plugin.configResolved === "function") {
      await plugin.configResolved.call({} as never, { command: "build", mode: "production" } as never);
    } else if (plugin.configResolved) {
      await plugin.configResolved.handler.call({} as never, { command: "build", mode: "production" } as never);
    }
    if (typeof plugin.transform !== "function") {
      throw new Error("Missing transform hook.");
    }

    const result = await plugin.transform.call(
      {
        error(error: string): never {
          throw new Error(error);
        },
      } as never,
      `<button>{label}</button>`,
      "/src/button.tachyon.html",
    );

    expect(typeof result === "object" && result?.code).not.toContain("sourceMappingURL");
    expect(uploaded).toEqual(["/src/button.tachyon.html"]);
    expect(
      shouldEmitSourceMap({ sourcemap: true, productionSourceMap: false, command: "build", mode: "production" }),
    ).toBe(false);
  });

  it("generates a virtual route manifest with lazy route modules", async () => {
    const plugin = tachyonDomRoutes({
      routes: [
        { id: "home", path: "/", module: "/src/routes/index.td" },
        { id: "user", path: "/users/:id", module: "/src/routes/users/[id].tachyon.html" },
      ],
      files: ["/src/routes/about.td"],
      rootDir: "/src/routes",
    });
    if (typeof plugin.resolveId !== "function" || typeof plugin.load !== "function") {
      throw new Error("Missing virtual module hooks.");
    }

    const resolved = await plugin.resolveId.call({} as never, "virtual:tachyon-dom/routes", undefined, {} as never);
    const code = await plugin.load.call({} as never, resolved as string, {} as never);

    expect(resolved).toBe("\0virtual:tachyon-dom/routes");
    expect(code).toContain(`export const manifest = routes.map`);
    expect(code).toContain(`module: () => import("/src/routes/users/[id].tachyon.html")`);
    expect(code).toContain(`module: () => import("/src/routes/index.td")`);
    expect(code).toContain(`path: "/about"`);
  });

  it("sends route HMR updates for changed route modules", () => {
    const plugin = tachyonDomRoutes({
      routes: [{ id: "home", path: "/", module: "/src/routes/index.td" }],
    });
    if (typeof plugin.handleHotUpdate !== "function") {
      throw new Error("Missing HMR hook.");
    }
    const module = { id: "\0virtual:tachyon-dom/routes" };
    const sent: unknown[] = [];

    const result = plugin.handleHotUpdate.call(
      {} as never,
      {
        file: "/src/routes/index.td",
        modules: [{ id: "/src/routes/index.td" }],
        server: {
          ws: {
            send: (payload: unknown) => sent.push(payload),
          },
          moduleGraph: {
            getModuleById: () => module,
            invalidateModule: (invalidated: unknown) => sent.push({ invalidated }),
          },
        },
      } as never,
    );

    expect(result).toEqual([module, { id: "/src/routes/index.td" }]);
    expect(sent).toContainEqual({
      type: "custom",
      event: "tachyon-dom:routes-update",
      data: { routeIds: ["home"] },
    });
  });
});
