import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

const projectRoot = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), "tachyon-whitespace-types-"));
const usageFile = path.join(directory, "usage.ts");
const modulePath = (file) => path.join(projectRoot, "dist", file).replaceAll("\\", "/");

const source = `
import { defineApp, renderAppDocument, type HtmlWhitespacePolicy, type LegacyHtmlWhitespacePolicy } from ${JSON.stringify(modulePath("app.js"))};
import type { TemplateWhitespacePolicy } from ${JSON.stringify(modulePath("compiler.js"))};
import { renderRoute, type RouteDefinition } from ${JSON.stringify(modulePath("router.js"))};
import { createWorkersHandler } from ${JSON.stringify(modulePath("adapters/workers.js"))};
import { createNodeHandler } from ${JSON.stringify(modulePath("adapters/node.js"))};
import { createLambdaHandler } from ${JSON.stringify(modulePath("adapters/lambda.js"))};
import { tachyonApp } from ${JSON.stringify(modulePath("vite.js"))};

const app = defineApp({ pages: [{ path: "/", fileName: "index.html", template: "<main>ok</main>", scope: {} }] });
const routes: RouteDefinition[] = [{ path: "/", render: () => "ok" }];
declare const htmlPolicy: HtmlWhitespacePolicy;
declare const templatePolicy: TemplateWhitespacePolicy;
declare const legacyPolicy: LegacyHtmlWhitespacePolicy;

app.renderDocument("/", { whitespace: "preserve" });
renderAppDocument(app, "/", { whitespace: "condense" });
tachyonApp(app, { htmlWhitespace: "condense" });
void renderRoute(routes, "/", { htmlWhitespace: "preserve" });
createWorkersHandler({ routes, htmlWhitespace: htmlPolicy });
createNodeHandler({ routes, htmlWhitespace: "condense" });
createLambdaHandler({ routes, htmlWhitespace: "preserve" });

// @ts-expect-error Template policy variables cannot configure tag normalization.
app.renderDocument("/", { whitespace: templatePolicy });
// @ts-expect-error Template policy variables cannot configure tag normalization.
renderAppDocument(app, "/", { whitespace: templatePolicy });
// @ts-expect-error Template policy variables cannot configure tag normalization.
tachyonApp(app, { htmlWhitespace: templatePolicy });
// @ts-expect-error Template policy variables cannot configure tag normalization.
void renderRoute(routes, "/", { htmlWhitespace: templatePolicy });
// @ts-expect-error Widened legacy variables are ambiguous.
createWorkersHandler({ routes, htmlWhitespace: legacyPolicy });
// @ts-expect-error Widened legacy variables are ambiguous.
createNodeHandler({ routes, htmlWhitespace: legacyPolicy });
// @ts-expect-error Widened legacy variables are ambiguous.
createLambdaHandler({ routes, htmlWhitespace: legacyPolicy });
`;

try {
  await writeFile(usageFile, source);
  const program = ts.createProgram([usageFile], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"),
    );
  }
  console.log("Packaged whitespace policy declarations verified.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
