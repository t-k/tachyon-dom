import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { build as viteBuild, createServer, type Plugin } from "vite";
import {
  addPageFiles,
  buildRouteManifestFile,
  createStarterFiles,
  compileFile,
  generateTemplateTypesFile,
  isCliEntrypoint,
  normalizeCliArgv,
  parseArgs,
  runCli,
  serverCommandMessage,
} from "../src/cli";
import {
  defineApp,
  generateTachyonModuleTypes,
  generateTemplateTypes,
  pagesFromRouteFiles,
  renderAppDocument,
  renderAppResponse,
  type HtmlWhitespacePolicy,
} from "../src/app";
import type { TemplateWhitespacePolicy } from "../src/compiler/types";
import { diagnoseTachyonSfc, diagnoseTemplate, formatDiagnostic } from "../src/diagnostics";
import { appendInlineSourceMap, createSourceMap, shouldEmitSourceMap } from "../src/source-map";
import { defineTemplate, templateScope, type TypedTemplate } from "../src/typed";
import { verifyPackageArtifacts } from "../src/package-integrity";
import { loadRouteApp, packageCloudflarePages, tachyonApp, tachyonDom, tachyonDomRoutes } from "../src/vite";
import * as viteIntegration from "../src/vite";
import { diagnosticsForTachyonDocument } from "../src/language-server";
import { renderTdForTest } from "../src/testing";

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
  it("keeps template and HTML tag whitespace policy types distinct", () => {
    expectTypeOf<TemplateWhitespacePolicy>().not.toEqualTypeOf<HtmlWhitespacePolicy>();
  });

  it("formats compiler diagnostics with line and column", () => {
    const result = diagnoseTemplate(`<main>\n<if></if>\n</main>`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected diagnostic.");
    }
    expect(result.error).toMatchObject({
      message: "<if> requires test={condition}.",
      line: 2,
      column: 1,
    });
    expect(formatDiagnostic(result.error, "bad.tachyon.html")).toContain(
      "bad.tachyon.html:2:1: <if> requires test={condition}.",
    );
  });

  it.each([
    ["if", `<main>\n  <p>valid</p>\n  <if></if>\n</main>`, 3, 3, 7],
    ["for", `<main>\n  <section>\n    <for each={items}></for>\n  </section>\n</main>`, 3, 5, 23],
    ["await", `<main>\n  <p>valid</p>\n  <await then="value"></await>\n</main>`, 3, 3, 23],
    ["component", `<main>\n  <section>\n    <component><p>child</p></component>\n  </section>\n</main>`, 3, 5, 16],
  ] as const)(
    "points a missing %s directive attribute at its opening tag",
    (_name, source, line, column, endColumn) => {
      const result = diagnoseTemplate(source);
      if (result.ok) throw new Error("Expected diagnostic.");

      expect(result.error).toMatchObject({ line, column, endLine: line, endColumn });
    },
  );

  it("points invalid bindings at the complete attribute range", () => {
    const result = diagnoseTemplate(`<main>\n  <input bind:value={user?.name}>\n</main>`);
    if (result.ok) throw new Error("Expected diagnostic.");

    expect(result.error).toMatchObject({
      message: "bind:value requires an assignable expression.",
      line: 2,
      column: 10,
      endLine: 2,
      endColumn: 33,
    });
  });

  it("maps semantic template ranges through preceding SFC scripts", () => {
    const result = diagnoseTachyonSfc(
      `<script>\nexport const scope = () => ({});\n</script>\n<main>\n  <if></if>\n</main>`,
    );
    if (result.ok) throw new Error("Expected diagnostic.");

    expect(result.error).toMatchObject({ line: 5, column: 3, endLine: 5, endColumn: 7 });
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

    defineApp({
      pages: [{ path: "/", fileName: "index.html", template: typed, scope: { title: "Home", count: 1 } }],
    });
    defineApp({
      pages: [
        // @ts-expect-error typed templates require a matching page scope
        { path: "/", fileName: "index.html", template: typed, scope: { count: 1 } },
      ],
    });
  });

  it("renders defineApp routes through a compiled SSR renderer", () => {
    const app = defineApp({
      pages: [
        {
          path: "/",
          fileName: "index.html",
          template: `<main><h1>{title.toUpperCase()}</h1><p>{count + 1}</p></main>`,
          scope: { title: "home", count: 1 },
        },
      ],
    });

    expect(app.renderRoute("/")).toBe(`<main><h1>HOME</h1><p>2</p></main>`);
  });

  it("applies template whitespace policy to defineApp and loadRouteApp route compilation", async () => {
    const source = `<section>\n  <p>Hello</p>\n</section>`;
    const condensed = defineApp({
      templateWhitespace: "condense",
      pages: [{ path: "/", fileName: "index.html", template: source }],
    });
    const preserved = defineApp({
      pages: [{ path: "/", fileName: "index.html", template: source }],
    });

    expect(condensed.renderRoute("/")).toBe(`<section> <p>Hello</p> </section>`);
    expect(preserved.renderRoute("/")).toBe(source);

    const directory = await mkdtemp(path.join(tmpdir(), "tachyon-template-whitespace-"));
    try {
      const routeDirectory = path.join(directory, "index");
      await mkdir(routeDirectory, { recursive: true });
      await writeFile(path.join(routeDirectory, "page.td"), source);
      const loaded = await loadRouteApp({ routesDir: directory, templateWhitespace: "condense" });
      expect(loaded.renderRoute("/")).toBe(condensed.renderRoute("/"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      url: "git+https://github.com/t-k/tachyon-dom.git",
    });
    expect(packageJson.keywords).toEqual(["compiler", "runtime", "ssr", "templates", "ui"]);
    expect(packageJson.engines?.node).toBe(">=24");
    expect(packageJson.publishConfig).toEqual({ access: "public" });

    const createPackageJson = JSON.parse(
      await readFile("packages/create-tachyon-dom/package.json", "utf8"),
    ) as { repository?: { type?: string; url?: string }; publishConfig?: { access?: string } };
    expect(createPackageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/t-k/tachyon-dom.git",
    });
    expect(createPackageJson.publishConfig).toEqual({ access: "public" });
  });

  it("keeps example build output outside the published dist directory", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = packageJson.scripts?.["example:hacker-news:build"] ?? "";

    expect(script).toContain("--outdir examples/hacker-news/dist/worker");
    expect(script).not.toContain("--outdir dist/");
  });

  it("derives packaged starter tarball names from package manifests", async () => {
    const verifier = await readFile("scripts/verify-generated-starters.mjs", "utf8");

    expect(verifier).toContain("rootPackage.version");
    expect(verifier).toContain("createPackage.version");
    expect(verifier).not.toContain('tachyon-dom-0.1.1.tgz');
    expect(verifier).not.toContain('create-tachyon-dom-0.1.1.tgz');
  });

  it("documents the recommended application shape", async () => {
    const gettingStarted = await readFile("docs/getting-started.md", "utf8");
    const adapters = await readFile("docs/adapters.md", "utf8");

    expect(gettingStarted).toContain("src/routes/index/page.td");
    expect(gettingStarted).toContain("src/client/main.ts");
    expect(gettingStarted).toContain("Do not put application code in `public/client/main.js`");
    expect(adapters).toContain("## Shared Contract");
  });

  it("documents typed templates, environment validation, and release gates", async () => {
    const readme = await readFile("README.md", "utf8");
    const runtimeDocs = await readFile("docs/runtime.md", "utf8");
    const releasingDocs = await readFile("docs/releasing.md", "utf8");

    expect(runtimeDocs).toContain("tachyon-dom/typed");
    expect(runtimeDocs).toContain("tachyon-dom/env");
    expect(readme).toContain("createResource");
    expect(runtimeDocs).toContain("createErrorBoundary");
    expect(runtimeDocs).toContain("createI18n");
    expect(runtimeDocs).toContain("viewTransition");
    expect(runtimeDocs).toContain("restoreScroll");
    expect(readme).toContain("pnpm check:exports");
    expect(readme).toContain("pnpm check:size");
    expect(runtimeDocs).toContain("defineTemplate()");
    expect(runtimeDocs).toContain("readEnv()");
    expect(releasingDocs).toContain("npm publish --access public");
    expect(releasingDocs).toContain("Trusted Publisher");
    expect(releasingDocs).toContain("automatically generates provenance");
    expect(releasingDocs).not.toContain("source repository is private");
  });

  it("runs package export/type and size gates in CI and release workflows", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
      exports?: Record<string, { import?: string }>;
      "size-limit"?: Array<{ name?: string; path?: string; limit?: string }>;
    };
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    const release = await readFile(".github/workflows/release.yml", "utf8");
    const publisher = await readFile("scripts/publish-release-package.mjs", "utf8");
    const releaseContract = await readFile("scripts/release-contract.mjs", "utf8");
    const finalizer = await readFile("scripts/finalize-release-tags.mjs", "utf8");
    const publicJsExportNames = Object.entries(packageJson.exports ?? {}).flatMap(([specifier, target]) => {
      if (!target.import) {
        return [];
      }
      return specifier === "." ? ["index"] : [specifier.replace(/^\.\//, "")];
    });

    expect(packageJson.scripts?.["check:exports"]).toBe(
      "publint --strict && attw --pack --no-emoji --profile esm-only",
    );
    expect(packageJson.scripts?.["check:size"]).toBe("size-limit");
    expect(packageJson.scripts?.["check:browser-entry"]).toBe("node scripts/verify-browser-entry.mjs");
    expect(packageJson["size-limit"]?.map((entry) => entry.name)).toEqual(publicJsExportNames);
    expect(packageJson["size-limit"]?.some((entry) => entry.name === "td-modules")).toBe(false);
    expect(ci).toContain("workflow_dispatch");
    expect(ci).toContain("pnpm check:exports");
    expect(ci).toContain("pnpm check:size");
    expect(ci).toContain("pnpm check:browser-entry");
    expect(ci).toContain("pnpm verify:whitespace-types");
    expect(ci).toContain("github.event_name == 'workflow_dispatch'");
    expect(ci).toContain("pnpm bench:local:smoke");
    expect(release).toContain("tags:");
    for (const command of [
      "pnpm verify:starters",
      "pnpm check:browser-entry",
      "pnpm check:quick-example-size",
      "pnpm verify:whitespace-types",
    ]) {
      expect(release).toContain(command);
    }
    expect(release).toContain("node scripts/publish-release-package.mjs --artifact-dir release-artifacts");
    expect(release).toContain("--package root");
    expect(release).toContain("--package create");
    expect(release).toContain("id-token: write");
    expect(releaseContract).not.toContain('"--provenance"');
    expect(publisher).toMatch(
      /"publish",\s*entry\.filename,\s*"--access",\s*"public",\s*"--tag",\s*stagingTagFor\(verified\.version\)/,
    );
    expect(publisher).toContain("if (confirmed.integrity !== entry.integrity) throw error");
    expect(finalizer).toContain("await addDistTag(entry.name, verified.version, verified.npmTag)");
  });

  it("pins CI actions and limits the job to repository reads", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const actionReferences = Array.from(workflow.matchAll(/uses:\s+([^\s#]+)/g), (match) => match[1]);

    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference ?? ""))).toBe(true);
    expect(workflow).toContain("permissions: {}\n");
    expect(workflow).toMatch(/test:\n[\s\S]+?permissions:\n\s+contents: read\n\s+steps:/);
  });

  it("pins release actions and keeps verification read-only", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const actionReferences = Array.from(workflow.matchAll(/uses:\s+([^\s#]+)/g), (match) => match[1]);
    const verifyJob = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  publish:"));

    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference ?? ""))).toBe(true);
    expect(verifyJob).toMatch(/permissions:\n\s+contents: read\n\s+steps:/);
    expect(verifyJob).not.toContain("contents: write");
    expect(verifyJob).not.toContain("id-token: write");
  });

  it("keeps the package root browser-safe and the request-scoped SSR example escaped", async () => {
    const indexSource = await readFile("src/index.ts", "utf8");
    const sfcSource = await readFile("src/compiler/sfc.ts", "utf8");
    const readme = await readFile("README.md", "utf8");
    const appViteDocs = await readFile("docs/app-vite.md", "utf8");

    expect(indexSource).not.toMatch(/\.\/app\.js|\.\/compiler\/|\.\/server\//);
    expect(sfcSource).toContain('compileTachyonSfc: "tachyon-dom/compiler"');
    expect(sfcSource).toContain('renderToReadableStream: "tachyon-dom/server/stream"');
    expect(appViteDocs).toContain('import { attr, html } from "tachyon-dom/server/html";');
    expect(appViteDocs).toContain("const body = html`");
    expect(appViteDocs).toContain('${attr("src", clientScript ?? "")}');
    expect(appViteDocs).toContain("new Response(String(body)");
    expect(appViteDocs).not.toContain("new Response(`<main>Hello ${user}</main><script");
    expect(readme).toContain("Events are attached once per created target");
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
      expect(dts).toContain(`export type AppTemplateScope = __TachyonAssertScope<ReturnType<typeof scope>>;`);
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
    expect(app.entries({ minify: true })[1]?.source).toContain('<meta charset="UTF-8" />');
    expect(app.pageForPath("/missing/")).toBeUndefined();
    expect(app.renderRoute("/missing/")).toBe("");
    expect(() => renderAppDocument(app, "/missing/")).toThrow("No page found");
  });

  it("renders an SFC page source through defineApp", () => {
    const define = (title: string) =>
      defineApp({
        pages: [
          {
            path: "/",
            fileName: "index.html",
            template: `<script>export const scope = () => ({ title: ${JSON.stringify(title)} });</script><section><h1>{title}</h1></section>`,
          },
        ],
      });

    expect(define("Welcome").renderRoute("/")).toBe("<section><h1>Welcome</h1></section>");
    expect(define("Edited in page.td").renderRoute("/")).toBe("<section><h1>Edited in page.td</h1></section>");
  });

  it("rejects duplicate normalized app paths and output names", () => {
    expect(() =>
      defineApp({
        pages: [
          { path: "/", fileName: "root.html", template: `<h1>Root</h1>` },
          { path: "/index.html", fileName: "alias.html", template: `<h1>Alias</h1>` },
          { path: "/guide", fileName: "guide.html", template: `<h1>Guide</h1>` },
          { path: "/guide/", fileName: "guide-copy.html", template: `<h1>Guide copy</h1>` },
          { path: "/other", fileName: "guide.html", template: `<h1>Other</h1>` },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          /path \/: root\.html, alias\.html[\s\S]*path \/guide\/: guide\.html, guide-copy\.html[\s\S]*file guide\.html: guide\.html, guide\.html/,
        ),
      }),
    );
  });

  it("returns an explicit SSR status and configured page for unknown app paths", () => {
    const app = defineApp({
      title: "Docs",
      pages: [{ path: "/", fileName: "index.html", template: `<h1>Home</h1>` }],
      notFound: {
        title: "Missing",
        render: ({ path }) => `<h1>Missing ${path}</h1>`,
      },
    });

    expect(renderAppResponse(app, "/")).toMatchObject({ status: 200, html: expect.stringContaining("<h1>Home</h1>") });
    expect(renderAppResponse(app, "/missing")).toMatchObject({
      status: 404,
      html: expect.stringContaining("<title>Missing</title>"),
    });
    expect(renderAppResponse(app, "/missing").html).toContain("<h1>Missing /missing</h1>");
    expect(() => renderAppDocument(app, "/missing")).toThrow("No page found");
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
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.value).toContain(path.join("settings", "profile", "page.td"));
      expect(result.value).toContain("Edit the generated page.td");
      expect(result.value).toContain("Route URL: /settings/profile/");
      expect(result.value).toContain("Generated declarations:");
      expect(result.value).toContain("Generated route registry:");
      expect(await readFile(path.join(routesDir, "settings", "profile", "page.td"), "utf8")).toContain(
        "<h1>{title}</h1>",
      );
      await expect(readFile(path.join(routesDir, "settings", "profile", "page.td.d.ts"), "utf8")).resolves.toContain(
        "__TachyonAssertScope",
      );
      await expect(readFile(path.join(dir, "src", "routes.generated.ts"), "utf8")).resolves.toContain(
        'path: "/settings/profile/"',
      );
      expect(await readFile(path.join(routesDir, "settings", "profile", "page.td"), "utf8")).toContain(
        `title: "Settings Profile"`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves an existing route-local page file on generator conflict", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-add-page-conflict-"));
    try {
      const routesDir = path.join(dir, "src", "routes");
      const page = path.join(routesDir, "settings", "page.td");
      const declarations = `${page}.d.ts`;
      await mkdir(path.dirname(page), { recursive: true });
      await writeFile(page, "user-authored\n");
      await writeFile(declarations, "user-authored declarations\n");

      const result = await addPageFiles({ name: "settings", routesDir });

      expect(result).toEqual({ ok: false, error: expect.stringContaining("Refusing to overwrite") });
      await expect(readFile(page, "utf8")).resolves.toBe("user-authored\n");

      const forced = await addPageFiles({ name: "settings", routesDir, force: true });
      expect(forced.ok && forced.value).toContain(`Overwrote ${page}`);
      expect(forced.ok && forced.value).toContain(`Overwrote ${declarations}`);
      await expect(readFile(page, "utf8")).resolves.toContain("<h1>{title}</h1>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves an orphan route declaration unless force is explicit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-add-page-orphan-declaration-"));
    try {
      const routesDir = path.join(dir, "src", "routes");
      const page = path.join(routesDir, "settings", "page.td");
      const declarations = `${page}.d.ts`;
      const registry = path.join(dir, "src", "routes.generated.ts");
      await mkdir(path.dirname(page), { recursive: true });
      await writeFile(declarations, "user-authored declarations\n");

      const result = await addPageFiles({ name: "settings", routesDir });

      expect(result).toEqual({ ok: false, error: expect.stringContaining(declarations) });
      await expect(readFile(declarations, "utf8")).resolves.toBe("user-authored declarations\n");
      await expect(access(page)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(registry)).rejects.toMatchObject({ code: "ENOENT" });

      const forced = await addPageFiles({ name: "settings", routesDir, force: true });
      expect(forced.ok && forced.value).toContain(`Overwrote ${declarations}`);
      await expect(readFile(page, "utf8")).resolves.toContain("<h1>{title}</h1>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates route-local starter files for new apps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-starter-"));
    try {
      const result = await createStarterFiles({ outDir: dir, template: "basic" });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.value).toContain("Edit src/routes/index/page.td");

      const page = await readFile(path.join(dir, "src", "routes", "index", "page.td"), "utf8");
      const app = await readFile(path.join(dir, "src", "app.ts"), "utf8");
      const registry = await readFile(path.join(dir, "src", "routes.generated.ts"), "utf8");
      const declarations = await readFile(path.join(dir, "src", "routes", "index", "page.td.d.ts"), "utf8");
      const client = await readFile(path.join(dir, "src", "client", "main.ts"), "utf8");
      const viteConfig = await readFile(path.join(dir, "vite.config.ts"), "utf8");
      const gitignore = await readFile(path.join(dir, ".gitignore"), "utf8");
      const ci = await readFile(path.join(dir, ".github", "workflows", "ci.yml"), "utf8");
      const smokeTest = await readFile(path.join(dir, "src", "app.test.ts"), "utf8");
      const tsconfig = JSON.parse(await readFile(path.join(dir, "tsconfig.json"), "utf8")) as {
        compilerOptions?: { types?: string[] };
      };
      const readme = await readFile(path.join(dir, "README.md"), "utf8");
      const packageJson = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      expect(page).toContain("<h1>{title}</h1>");
      expect(page).toContain("Welcome");
      expect(app).toContain(`import { pages } from "./routes.generated";`);
      expect(app).toContain('templateWhitespace: "condense"');
      expect(app).toContain("pages,");
      expect(registry).toContain(`import routeSource0 from "./routes/index/page.td?raw";`);
      expect(registry).toContain('path: "/"');
      expect(declarations).toContain("ReturnType<typeof scope>");
      expect(client).toContain("Client entry for Tachyon DOM runtime code.");
      expect(viteConfig).toContain('const templateWhitespace = "condense" as const;');
      expect(viteConfig).toContain("templateWhitespace,");
      expect(viteConfig).toContain("tachyonDom({ reactive: true, templateWhitespace })");
      expect(viteConfig).toContain('tachyonApp(app, { appScript: "/src/client/main.ts" })');
      expect(viteConfig).toContain(`input: "src/client/main.ts"`);
      expect(gitignore).toContain("node_modules/");
      expect(gitignore).toContain("dist/");
      expect(ci).toContain("pnpm typecheck");
      expect(ci).toContain("pnpm test");
      expect(smokeTest).toContain("renders the starter page");
      expect(tsconfig.compilerOptions?.types).toEqual(["vite/client", "node", "tachyon-dom/td-modules"]);
      expect(packageJson.devDependencies?.["@types/node"]).toBe("^24.0.3");
      expect(readme).toContain("Edit `src/routes/index/page.td`");
      expect(readme).toContain("Route registration");
      expect(readme).toContain("Do not put application code in `public/client/main.js`");
      expect(readme).toContain("Adapters are lower-level deployment APIs");
      expect(packageJson.scripts).toMatchObject({
        build: "vite build",
        dev: "vite",
        preview: "vite preview",
        typecheck: "tsc --noEmit",
      });
      expect(packageJson.dependencies).toHaveProperty("tachyon-dom");
      expect(packageJson.devDependencies).toHaveProperty("typescript");
      expect(packageJson.devDependencies).toHaveProperty("vite");
      expect(packageJson).toHaveProperty("packageManager", "pnpm@10.32.1");
      await expect(readFile(path.join(dir, "public", "client", "main.js"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders generated and added pages through the real app and Vite path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-starter-integration-"));
    let moduleServer: Awaited<ReturnType<typeof createServer>> | undefined;
    let devServer: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      const starter = await createStarterFiles({ outDir: dir, template: "basic" });
      if (!starter.ok) throw new Error(starter.error);
      const routesDir = path.join(dir, "src", "routes");
      for (const name of ["settings/profile", "users/[id]", "blog/[...slug]"]) {
        const added = await addPageFiles({ name, routesDir });
        if (!added.ok) throw new Error(added.error);
      }
      const dynamic = await addPageFiles({ name: "preview/[id]", routesDir });
      expect(dynamic.ok && dynamic.value).toContain("Route URL: /preview/:id/");
      const catchAll = await addPageFiles({ name: "archive/[...slug]", routesDir });
      expect(catchAll.ok && catchAll.value).toContain("Route URL: /archive/*slug/");
      const fileApp = await loadRouteApp({ routesDir, title: "Tachyon App" });
      expect(fileApp.renderRoute("/users/42/")).toContain("<h1>Users Id</h1>");
      const indexDeclaration = path.join(routesDir, "index", "page.td.d.ts");
      await writeFile(indexDeclaration, "stale declaration\n");

      moduleServer = await createServer({
        configFile: false,
        logLevel: "silent",
        root: dir,
        plugins: [tachyonDom({ reactive: true })],
        resolve: { alias: [{ find: "tachyon-dom/app", replacement: path.join(process.cwd(), "src", "app.ts") }] },
        server: { middlewareMode: true },
      });
      const loaded = (await moduleServer.ssrLoadModule("/src/app.ts")) as { app: ReturnType<typeof defineApp> };
      await expect(readFile(indexDeclaration, "utf8")).resolves.toContain("ReturnType<typeof scope>");
      expect(loaded.app.renderRoute("/")).toContain("<h1>Welcome</h1>");
      expect(loaded.app.renderRoute("/settings/profile/")).toContain("<h1>Settings Profile</h1>");
      expect(loaded.app.renderRoute("/users/42/")).toContain("<h1>Users Id</h1>");
      expect(loaded.app.renderRoute("/blog/2026/launch/")).toContain("<h1>Blog Slug</h1>");
      const typecheck = ts.createProgram(
        [
          path.join(dir, "src", "app.ts"),
          path.join(dir, "src", "routes.generated.ts"),
          ...loaded.app.pages.map((page) =>
            path.join(
              routesDir,
              page.path === "/" ? "index/page.td.d.ts" : `${page.fileName.replace(/index\.html$/, "page.td.d.ts")}`,
            ),
          ),
          path.join(process.cwd(), "src", "tachyon-html.d.ts"),
        ],
        {
          baseUrl: process.cwd(),
          ignoreDeprecations: "6.0",
          lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          noEmit: true,
          paths: { "tachyon-dom/app": ["src/app.ts"] },
          skipLibCheck: false,
          strict: true,
          target: ts.ScriptTarget.ES2022,
        },
      );
      expect(
        ts
          .getPreEmitDiagnostics(typecheck)
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
      ).toEqual([]);

      await viteBuild({
        configFile: false,
        logLevel: "silent",
        root: dir,
        plugins: [tachyonDom({ reactive: true }), tachyonApp(loaded.app, { appScript: "/src/client/main.ts" })],
        build: { outDir: "dist", rollupOptions: { input: path.join(dir, "src", "client", "main.ts") } },
      });
      await expect(readFile(path.join(dir, "dist", "index.html"), "utf8")).resolves.toContain("Welcome");
      await expect(readFile(path.join(dir, "dist", "settings", "profile", "index.html"), "utf8")).resolves.toContain(
        "Settings Profile",
      );

      devServer = await createServer({
        configFile: false,
        logLevel: "silent",
        root: dir,
        plugins: [tachyonDom({ reactive: true }), tachyonApp(loaded.app, { appScript: "/src/client/main.ts" })],
        server: { host: "127.0.0.1", port: 0 },
      });
      await devServer.listen();
      const localUrl = devServer.resolvedUrls?.local.find((url) => url.startsWith("http://127.0.0.1"));
      if (!localUrl) throw new Error("Missing Vite URL.");
      const response = await fetch(localUrl);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Welcome");
    } finally {
      await devServer?.close();
      await moduleServer?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not partially create a starter when a managed file conflicts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-starter-conflict-"));
    try {
      await writeFile(path.join(dir, "package.json"), "user-authored\n");
      await writeFile(path.join(dir, "README.md"), "user-readme\n");

      const result = await createStarterFiles({ outDir: dir, template: "basic" });

      expect(result).toEqual({ ok: false, error: expect.stringContaining("Refusing to overwrite") });
      await expect(readFile(path.join(dir, "package.json"), "utf8")).resolves.toBe("user-authored\n");
      await expect(readFile(path.join(dir, "README.md"), "utf8")).resolves.toBe("user-readme\n");
      await expect(readFile(path.join(dir, "src", "routes", "index", "page.td"), "utf8")).rejects.toThrow();

      const forced = await createStarterFiles({ outDir: dir, template: "basic", force: true });
      expect(forced.ok && forced.value).toContain("Overwrote");
      expect(forced.ok && forced.value).toContain(path.join(dir, "package.json"));
      expect(forced.ok && forced.value).toContain(path.join(dir, "README.md"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates an SSR starter with an explicit server entry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-ssr-starter-"));
    try {
      const result = await createStarterFiles({ outDir: dir, template: "ssr" });

      expect(result.ok).toBe(true);
      const server = await readFile(path.join(dir, "src", "server.ts"), "utf8");
      const readme = await readFile(path.join(dir, "README.md"), "utf8");

      expect(server).toContain("renderAppResponse");
      expect(readme).toContain("SSR entry");
      expect(result.ok && result.value).not.toContain("same Vite SSR shape as basic");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps the create-tachyon-dom bin to init arguments", () => {
    expect(normalizeCliArgv(["my-app", "--template", "ssr"], "/repo/node_modules/.bin/create-tachyon-dom")).toEqual([
      "init",
      "--out",
      "my-app",
      "--template",
      "ssr",
    ]);
    expect(normalizeCliArgv(["--template", "basic"], "/repo/node_modules/.bin/create-tachyon-dom")).toEqual([
      "init",
      "--template",
      "basic",
    ]);
  });

  it("ships a create-tachyon-dom package for npm create and pnpm create", async () => {
    const packageJson = JSON.parse(await readFile("packages/create-tachyon-dom/package.json", "utf8")) as {
      name?: string;
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const entry = await readFile("packages/create-tachyon-dom/src/index.ts", "utf8");
    const readme = await readFile("README.md", "utf8");

    expect(packageJson.name).toBe("create-tachyon-dom");
    expect(packageJson.bin).toEqual({ "create-tachyon-dom": "./dist/index.js" });
    expect(packageJson.dependencies).toHaveProperty("tachyon-dom");
    expect(entry).toContain(`runCli(process.argv.slice(2), "create-tachyon-dom")`);
    expect(readme).toContain("npm create tachyon-dom@latest my-app");
    expect(readme).toContain("pnpm create tachyon-dom my-app");
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

  it("prints the package version and command-specific CLI help", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };
    try {
      await expect(runCli(["--version"])).resolves.toBe(0);
      await expect(runCli(["compile", "--help"])).resolves.toBe(0);
      await expect(runCli(["dev", "--help"])).resolves.toBe(0);
      await expect(runCli(["add", "--help"])).resolves.toBe(0);
      await expect(runCli(["init", "--help"])).resolves.toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(messages[0]).toBe("0.1.2");
    expect(messages[1]).toContain("tachyon-dom compile <input>");
    expect(messages[1]).toContain("--target client|server|stream");
    expect(messages[2]).toContain("tachyon-dom dev");
    expect(messages[2]).toContain("--host");
    expect(messages[2]).toContain("--port");
    expect(messages[3]).toContain("Existing files are preserved unless --force is explicit.");
    expect(messages[4]).toContain("Any conflict aborts all writes unless --force is explicit.");
  });

  it("parses explicit generator overwrite options", () => {
    expect(parseArgs(["add", "page", "settings", "--force"])).toMatchObject({
      ok: true,
      value: { command: "add-page", name: "settings", force: true },
    });
    expect(parseArgs(["init", "--out", "app", "--force"])).toEqual({
      ok: true,
      value: { command: "init", outDir: "app", template: "basic", force: true },
    });
  });

  it("detects CLI entrypoints through npm bin symlinks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-bin-"));
    try {
      const physicalDir = path.join(dir, "physical");
      const aliasDir = path.join(dir, "alias");
      const target = path.join(physicalDir, "dist", "cli.js");
      const link = path.join(physicalDir, "node_modules", ".bin", "tachyon-dom");
      await mkdir(path.dirname(target), { recursive: true });
      await mkdir(path.dirname(link), { recursive: true });
      await writeFile(target, "");
      await symlink(target, link);
      await symlink(physicalDir, aliasDir, "dir");

      await expect(isCliEntrypoint(link, pathToFileURL(path.join(aliasDir, "dist", "cli.js")).href)).resolves.toBe(
        true,
      );
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
    expect(code).toContain(`__tachyonMountKeyedList(__tachyonTarget0, [], __tachyonRead(scope.rows)`);
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

  it("applies one template whitespace policy to every Vite target", async () => {
    const plugin = tachyonDom({ reactive: true, templateWhitespace: "condense" });
    if (typeof plugin.transform !== "function") throw new Error("Missing transform hook.");
    const context = {
      error(error: string): never {
        throw new Error(error);
      },
    } as never;
    const source = `<main>
  <section hydrate:id={id}>Hello {name}!</section>
</main>`;

    const server = await plugin.transform.call(context, source, "/src/page.td?server");
    const stream = await plugin.transform.call(context, source, "/src/page.td?stream");
    const client = await plugin.transform.call(context, source, "/src/page.td?client");
    const codes = [server, stream, client].map((result) =>
      typeof result === "object" ? String(result?.code ?? "") : "",
    );

    expect(codes.every((code) => !code.includes("\\n  "))).toBe(true);
    expect(codes[0]).toContain("tachyon-hydrate:");
    expect(codes[1]).toContain("tachyon-hydrate:");
    expect(codes[2]).toContain("<!---->");
    expect(codes.every((code) => code.includes("Hello "))).toBe(true);
  });

  it("writes synchronized module declarations during Vite transforms", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-vite-types-"));
    try {
      const output = path.join(dir, "page.td.d.ts");
      const plugin = tachyonDom({ declarationOutput: () => output });
      if (typeof plugin.transform !== "function") throw new Error("Missing transform hook.");

      await plugin.transform.call(
        {
          error: (error: string): never => {
            throw new Error(error);
          },
        } as never,
        `<main>{title}</main>`,
        "/src/page.td",
      );

      await expect(readFile(output, "utf8")).resolves.toContain("title: unknown;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("regenerates adjacent template declarations during normal Vite transforms", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-auto-types-"));
    try {
      const physicalDir = path.join(dir, "physical");
      const aliasDir = path.join(dir, "alias");
      const id = path.join(physicalDir, "page.td");
      await mkdir(physicalDir);
      await symlink(physicalDir, aliasDir, "dir");
      await writeFile(id, `<main>{title}</main>`);
      const plugin = tachyonDom();
      if (typeof plugin.transform !== "function" || typeof plugin.configResolved !== "function") {
        throw new Error("Missing Vite hooks.");
      }
      await plugin.configResolved.call(
        {} as never,
        {
          command: "serve",
          mode: "development",
          root: aliasDir,
        } as never,
      );
      const context = {
        error: (error: string): never => {
          throw new Error(error);
        },
      } as never;

      await plugin.transform.call(context, `<main>{title}</main>`, `${id}?raw`);
      await expect(readFile(`${id}.d.ts`, "utf8")).resolves.toContain("title: unknown;");
      await plugin.transform.call(context, `<main>{title}<small>{subtitle}</small></main>`, `${id}?raw`);
      await expect(readFile(`${id}.d.ts`, "utf8")).resolves.toContain("subtitle: unknown;");

      const generatedId = path.join(aliasDir, "generated.td");
      await plugin.transform.call(context, `<main>{generated}</main>`, `${generatedId}?raw`);
      await expect(readFile(`${generatedId}.d.ts`, "utf8")).resolves.toContain("generated: unknown;");

      const outsideDir = path.join(dir, "outside");
      await mkdir(outsideDir);
      await symlink(outsideDir, path.join(physicalDir, "external"), "dir");
      const escapedId = path.join(aliasDir, "external", "escaped.td");
      await plugin.transform.call(context, `<main>{escaped}</main>`, `${escapedId}?raw`);
      await expect(access(`${escapedId}.d.ts`)).rejects.toMatchObject({ code: "ENOENT" });

      const siblingDir = `${aliasDir}-other`;
      await mkdir(siblingDir);
      const siblingId = path.join(siblingDir, "sibling.td");
      await plugin.transform.call(context, `<main>{sibling}</main>`, `${siblingId}?raw`);
      await expect(access(`${siblingId}.d.ts`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps Vite declaration diagnostics aligned with SFC source locations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-vite-diagnostic-location-"));
    try {
      const id = path.join(dir, "page.td");
      const source = `<script>\nexport const scope = () => ({});\n</script>\n<main>\n  <if></if>\n</main>`;
      const plugin = tachyonDom();
      if (typeof plugin.transform !== "function" || typeof plugin.configResolved !== "function") {
        throw new Error("Missing Vite hooks.");
      }
      await plugin.configResolved.call({} as never, { command: "serve", mode: "development", root: dir } as never);

      await expect(
        plugin.transform.call(
          {
            error(error: string): never {
              throw new Error(error);
            },
          } as never,
          source,
          `${id}?raw`,
        ),
      ).rejects.toThrow(`${id}:5:3: <if> requires test={condition}.`);
      await expect(access(`${id}.d.ts`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps CLI, Vite, testing, and LSP locations aligned for one SFC fixture", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-cross-surface-diagnostic-"));
    try {
      const id = path.join(dir, "page.td");
      const source = `<script>\nexport const scope = () => ({});\n</script>\n<main>\n  <if></if>\n</main>`;
      await writeFile(id, source);
      const cli = await compileFile({ input: id, target: "server", reactive: false, sourcemap: false });
      expect(cli.ok).toBe(false);
      if (cli.ok) throw new Error("Expected CLI diagnostic.");
      expect(cli.error).toContain(`${id}:5:3:`);
      await expect(renderTdForTest(id)).rejects.toThrow(`${id}:5:3:`);
      expect(diagnosticsForTachyonDocument(source)[0]?.range).toEqual({
        start: { line: 4, character: 2 },
        end: { line: 4, character: 6 },
      });

      const plugin = tachyonDom();
      if (typeof plugin.transform !== "function" || typeof plugin.configResolved !== "function") {
        throw new Error("Missing Vite hooks.");
      }
      await plugin.configResolved.call({} as never, { command: "serve", mode: "development", root: dir } as never);
      await expect(
        plugin.transform.call(
          {
            error(error: string): never {
              throw new Error(error);
            },
          } as never,
          source,
          `${id}?raw`,
        ),
      ).rejects.toThrow(`${id}:5:3:`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports missing scope fields and incorrectly typed handlers from per-file declarations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-scope-errors-"));
    try {
      const diagnosticsFor = async (name: string, source: string, usage: string): Promise<string[]> => {
        const declarations = generateTachyonModuleTypes(source);
        if (!declarations.ok) throw new Error(declarations.error);
        const declarationFile = path.join(dir, `${name}.td.d.ts`);
        const usageFile = path.join(dir, `${name}.ts`);
        await writeFile(declarationFile, declarations.value);
        await writeFile(usageFile, usage);
        const program = ts.createProgram([usageFile, declarationFile], {
          lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: ts.ScriptTarget.ES2022,
        });
        return ts
          .getPreEmitDiagnostics(program)
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      };
      const missing = await diagnosticsFor(
        "missing",
        `<script lang="ts">\nexport const scope = () => ({ title: "Home" });\n</script>\n<main>{title}<p>{missing}</p></main>`,
        `import { bind, scope } from "./missing.td";\nbind(document.body, scope());\n`,
      );
      const handler = await diagnosticsFor(
        "handler",
        `<script lang="ts">\nexport const scope = () => ({ onSave: 123 });\n</script>\n<button on:click={onSave}>Save</button>`,
        `import { bind, scope } from "./handler.td";\nbind(document.body, scope());\n`,
      );
      const call = await diagnosticsFor(
        "call",
        `<script lang="ts">\nexport const scope = () => ({ title: "Home" });\n</script>\n<h1>{title}</h1>`,
        `import { bind } from "./call.td";\nbind(document.body, {});\n`,
      );

      expect(missing.some((message) => message.includes("Property 'missing' is missing"))).toBe(true);
      expect(handler.some((message) => message.includes("onSave") && message.includes("(event: Event)"))).toBe(true);
      expect(call.some((message) => message.includes("Argument of type '{}'") && message.includes("title"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exports ambient types for .td modules through a package subpath", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; import?: string }>;
    };
    const tdModulesExport = packageJson.exports?.["./td-modules"];
    expect(tdModulesExport).toMatchObject({ types: "./dist/tachyon-html.d.ts" });

    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-td-types-"));
    try {
      const packageDir = path.join(dir, "node_modules", "tachyon-dom");
      await mkdir(path.join(packageDir, "dist"), { recursive: true });
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify(
          {
            name: "tachyon-dom",
            type: "module",
            exports: { "./td-modules": tdModulesExport },
          },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(packageDir, "dist", "tachyon-html.d.ts"),
        await readFile(path.join(process.cwd(), "src", "tachyon-html.d.ts"), "utf8"),
      );
      await writeFile(
        path.join(dir, "src", "app.ts"),
        `/// <reference types="tachyon-dom/td-modules" />
import defaultScope, { bind, componentBoundaries, hydrationBoundaries, scope, templateHtml } from "./view.td";
import { bind as bindClient, templateHtml as clientHtml } from "./view.td?client";
import { render, renderHydrationState } from "./view.td?server";
import { stream } from "./view.td?stream";
import rawSource from "./view.td?raw";

const root = document.createElement("main");
const resolvedDefaultScope = typeof defaultScope === "function" ? defaultScope({}) : defaultScope;
const resolvedNamedScope = typeof scope === "function" ? scope(resolvedDefaultScope) : scope;
const cleanup = bind(root, resolvedNamedScope);
if (typeof cleanup === "function") {
  cleanup();
}
bindClient(root, {});
const rendered: string = render({ title: "Home" });
const state: string = renderHydrationState("route", { ok: true });
const raw: string = rawSource;
const html: string = templateHtml + clientHtml + rendered + state + raw;
const markers: readonly unknown[] = hydrationBoundaries;
const components: readonly unknown[] = componentBoundaries;
const chunks: AsyncIterable<string> = stream({});
void html;
void markers;
void components;
void chunks;
`,
      );
      await writeFile(
        path.join(dir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              lib: ["ES2022", "DOM", "DOM.Iterable"],
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
            },
            include: ["src"],
          },
          null,
          2,
        ),
      );

      const configPath = path.join(dir, "tsconfig.json");
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      const diagnostics = ts.getPreEmitDiagnostics(program);

      expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual(
        [],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verifies package export and bin artifacts before release", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const workflow = await readFile(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    expect(packageJson.scripts?.["verify:package"]).toBe(
      "node scripts/verify-package-artifacts.mjs && node scripts/verify-middleware-context-types.mjs",
    );
    expect(packageJson.scripts?.["verify:starters"]).toBe("node scripts/verify-generated-starters.mjs");
    expect(workflow).toContain("pnpm verify:package");
    expect(workflow).toContain("pnpm verify:starters");
    await expect(
      readFile(path.join(process.cwd(), "scripts", "verify-generated-starters.mjs"), "utf8"),
    ).resolves.toContain('"create-tachyon-dom"');

    const realResult = await verifyPackageArtifacts({ packageDir: process.cwd(), checkPack: false });
    expect(realResult.ok).toBe(true);
    if (!realResult.ok) {
      throw new Error(realResult.error);
    }
    expect(realResult.value.checkedFiles).toContain("dist/tachyon-html.d.ts");

    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-package-artifacts-"));
    try {
      await mkdir(path.join(dir, "dist"), { recursive: true });
      await writeFile(path.join(dir, "dist", "index.js"), "export {};\n");
      await writeFile(path.join(dir, "dist", "index.d.ts"), "export {};\n");
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify(
          {
            name: "fixture-package",
            version: "0.0.0",
            type: "module",
            files: ["dist"],
            bin: { fixture: "./dist/cli.js" },
            exports: {
              ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
              "./missing": { types: "./dist/missing.d.ts" },
            },
          },
          null,
          2,
        ),
      );

      const missing = await verifyPackageArtifacts({ packageDir: dir, checkPack: true });
      expect(missing.ok).toBe(false);
      expect(!missing.ok && missing.error).toContain("bin.fixture -> ./dist/cli.js");
      expect(!missing.ok && missing.error).toContain("exports../missing.types -> ./dist/missing.d.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("validates and dry-runs both npm packages before ordered publication", async () => {
    const workflow = await readFile(path.join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
    const createPackage = JSON.parse(
      await readFile(path.join(process.cwd(), "packages", "create-tachyon-dom", "package.json"), "utf8"),
    ) as { files?: string[]; dependencies?: Record<string, string> };
    const preparation = workflow.indexOf("pnpm prepare:release");
    const releaseGates = [
      "pnpm verify:starters",
      "pnpm check:browser-entry",
      "pnpm check:quick-example-size",
      "pnpm verify:whitespace-types",
    ];
    const dryRun = workflow.indexOf("--dry-run-artifacts", preparation);
    const upload = workflow.indexOf("actions/upload-artifact@", dryRun);
    const publishJob = workflow.indexOf("publish:", upload);
    const artifactVerification = workflow.indexOf("--verify-artifacts", publishJob);
    const preflight = workflow.indexOf("preflight-release-publication.mjs", artifactVerification);
    const rootPublish = workflow.indexOf("--package root", preflight);
    const createPublish = workflow.indexOf("--package create", rootPublish + 1);
    const finalize = workflow.indexOf("finalize-release-tags.mjs", createPublish);

    expect(preparation).toBeGreaterThan(-1);
    for (const command of releaseGates) {
      expect(workflow.indexOf(command)).toBeGreaterThan(-1);
      expect(workflow.indexOf(command)).toBeLessThan(preparation);
      expect(workflow.indexOf(command)).toBe(workflow.lastIndexOf(command));
    }
    expect(dryRun).toBeGreaterThan(preparation);
    expect(upload).toBeGreaterThan(dryRun);
    expect(publishJob).toBeGreaterThan(upload);
    expect(artifactVerification).toBeGreaterThan(publishJob);
    expect(preflight).toBeGreaterThan(artifactVerification);
    expect(rootPublish).toBeGreaterThan(preflight);
    expect(createPublish).toBeGreaterThan(rootPublish);
    expect(finalize).toBeGreaterThan(createPublish);
    expect(workflow).toContain("permissions: {}\n");
    expect(workflow).toContain("group: tachyon-dom-npm-release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toMatch(
      /publish:\n\s+needs: verify[\s\S]+permissions:\n\s+contents: read\n\s+id-token: write\n\s+steps:/,
    );
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    const finalizerSection = workflow.slice(finalize);
    const publishSection = workflow.slice(publishJob, finalize);
    expect(publishSection).not.toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(finalizerSection).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain("34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(workflow).toContain("ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain("d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(createPackage.files).toContain("LICENSE");
    expect(createPackage.dependencies?.["tachyon-dom"]).toBe("0.1.2");
  });

  it("packages a Cloudflare Pages worker with copied assets and ASSETS fallback", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-pages-package-"));
    try {
      const publicDir = path.join(dir, "public");
      const srcDir = path.join(dir, "src");
      const outDir = path.join(dir, "pages");
      await mkdir(path.join(publicDir, "assets"), { recursive: true });
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(publicDir, "assets", "app.css"), "body{color:red}");
      await writeFile(
        path.join(srcDir, "entry.ts"),
        `export const renderRequest = (request, env) => new Response(String(env.SSR_API_BASE_URL) + ":" + new URL(request.url).pathname, { headers: { "x-rendered": "yes" } });\n`,
      );

      const result = await packageCloudflarePages({
        assetsDir: publicDir,
        entry: path.join(srcDir, "entry.ts"),
        outDir,
        runtimeEnvKeys: ["SSR_API_BASE_URL"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(await readdir(outDir)).toContain("_worker.js");
      expect(await readFile(path.join(outDir, "assets", "app.css"), "utf8")).toBe("body{color:red}");
      const workerCode = await readFile(result.value.workerPath, "utf8");
      const workerModule = (await import(
        /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(workerCode).toString("base64")}`
      )) as {
        default: { fetch: (request: Request, env: Record<string, unknown>, ctx: unknown) => Promise<Response> };
      };
      const assetFetch = vi.fn((request: Request) =>
        new URL(request.url).pathname === "/assets/app.css"
          ? new Response("asset css", { headers: { "content-type": "text/css" } })
          : new Response("missing", { status: 404 }),
      );

      const asset = await workerModule.default.fetch(
        new Request("https://example.com/assets/app.css"),
        { ASSETS: { fetch: assetFetch }, SSR_API_BASE_URL: "https://api.example" },
        {},
      );
      expect(await asset.text()).toBe("asset css");

      const page = await workerModule.default.fetch(
        new Request("https://example.com/dashboard"),
        { ASSETS: { fetch: assetFetch }, SSR_API_BASE_URL: "https://api.example" },
        {},
      );
      expect(page.headers.get("x-rendered")).toBe("yes");
      expect(await page.text()).toBe("https://api.example:/dashboard");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it("serves request-scoped SSR through a Vite middleware preset", async () => {
    type TachyonSsrForTest = (options: {
      fetch: (request: Request, context: { clientScript?: string }) => Response | Promise<Response>;
      staticAssets?: { rootDir: string; basePath?: string; fallthroughOnNotFound?: boolean };
      clientScript?: string | ((request: Request) => string | Promise<string>);
    }) => Plugin;
    const tachyonSsr = (viteIntegration as typeof viteIntegration & { tachyonSsr?: TachyonSsrForTest }).tachyonSsr;
    expect(tachyonSsr).toBeTypeOf("function");
    if (!tachyonSsr) {
      throw new Error("Missing tachyonSsr export.");
    }

    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-vite-ssr-"));
    const seenPaths: string[] = [];
    const server = await createServer({
      root: dir,
      logLevel: "silent",
      plugins: [
        tachyonSsr({
          fetch: (request, context) => {
            const url = new URL(request.url);
            seenPaths.push(`${url.pathname}${url.search}`);
            return new Response(
              `<main>${url.searchParams.get("name") ?? "Guest"}</main><script type="module" src="${context.clientScript ?? ""}"></script>`,
              { headers: { "content-type": "text/html; charset=utf-8" } },
            );
          },
          staticAssets: { rootDir: path.join(dir, "public"), basePath: "/", fallthroughOnNotFound: true },
          clientScript: (request) =>
            new URL(request.url).searchParams.has("prod") ? "/client/main.js" : "/src/client/main.ts",
        }),
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
      },
    });
    try {
      await mkdir(path.join(dir, "public"), { recursive: true });
      await mkdir(path.join(dir, "src", "client"), { recursive: true });
      await writeFile(path.join(dir, "public", "logo.txt"), "static asset");
      await writeFile(path.join(dir, "src", "client", "main.ts"), "export const started = true;");

      await server.listen();
      const localUrl = server.resolvedUrls?.local.find((url) => url.startsWith("http://127.0.0.1"));
      if (!localUrl) {
        throw new Error("Missing Vite local URL.");
      }

      const page = await fetch(`${localUrl}dashboard?name=Ada`);
      const pageHtml = await page.text();
      const prodPage = await fetch(`${localUrl}dashboard?name=Ada&prod=1`);
      const prodHtml = await prodPage.text();
      const asset = await fetch(`${localUrl}logo.txt`);
      const assetText = await asset.text();
      const viteClient = await fetch(`${localUrl}@vite/client`);
      await viteClient.text();
      const sourceModule = await fetch(`${localUrl}src/client/main.ts`);
      const sourceModuleText = await sourceModule.text();

      expect(page.status).toBe(200);
      expect(pageHtml).toContain("<main>Ada</main>");
      expect(pageHtml).toContain(`src="/src/client/main.ts"`);
      expect(prodHtml).toContain(`src="/client/main.js"`);
      expect(asset.status).toBe(200);
      expect(assetText).toBe("static asset");
      expect(viteClient.status).toBe(200);
      expect(sourceModule.status).toBe(200);
      expect(sourceModuleText).toContain("started");
      expect(seenPaths).toEqual(["/dashboard?name=Ada", "/dashboard?name=Ada&prod=1"]);
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

  it("wires hydration diagnostics into Vite entry modules", async () => {
    const plugin = tachyonDom({ reactive: true });
    if (typeof plugin.load !== "function") {
      throw new Error("Missing load hook.");
    }

    const code = await plugin.load.call({} as never, "/src/view.td?entry", {} as never);

    expect(code).toContain(`reportHydrationDiagnostics`);
    expect(code).toContain(`import.meta.hot`);
    expect(code).toContain(`module.hydrationBoundaries`);
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
