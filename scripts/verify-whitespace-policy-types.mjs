import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), "tachyon-whitespace-package-"));
const consumer = path.join(directory, "consumer");

const source = `
import { defineApp, renderAppDocument, type HtmlWhitespacePolicy } from "tachyon-dom/app";
import type { TemplateWhitespacePolicy } from "tachyon-dom/compiler";
import { renderRoute, type RouteDefinition } from "tachyon-dom/router";
import { createWorkersHandler } from "tachyon-dom/adapters/workers";
import { createNodeHandler } from "tachyon-dom/adapters/node";
import { createLambdaHandler, createLambdaStreamingHandler } from "tachyon-dom/adapters/lambda";
import { tachyonApp } from "tachyon-dom/vite";

const app = defineApp({ pages: [{ path: "/", fileName: "index.html", template: "<main>ok</main>", scope: {} }] });
const routes: RouteDefinition[] = [{ path: "/", render: () => "ok" }];
declare const htmlPolicy: HtmlWhitespacePolicy;
const literalTemplatePolicy: TemplateWhitespacePolicy = "condense";
let mutableTemplatePolicy: TemplateWhitespacePolicy = "preserve";
if (Math.random() > 0.5) mutableTemplatePolicy = "condense";
declare const partialMixed: "condense" | "normalize-tags";

app.renderDocument("/", { whitespace: "preserve-tags" });
renderAppDocument(app, "/", { whitespace: "normalize-tags" });
tachyonApp(app, { htmlWhitespace: htmlPolicy });
void renderRoute(routes, "/", { htmlWhitespace: "preserve-tags" });
createWorkersHandler({ routes, htmlWhitespace: htmlPolicy });
createNodeHandler({ routes, htmlWhitespace: "normalize-tags" });
createLambdaHandler({ routes, htmlWhitespace: htmlPolicy });
createLambdaStreamingHandler({ routes, htmlWhitespace: "preserve-tags" });

// @ts-expect-error Legacy literals are rejected.
app.renderDocument("/", { whitespace: "condense" });
// @ts-expect-error Legacy literals are rejected.
renderAppDocument(app, "/", { whitespace: "preserve" });
// @ts-expect-error Literal-narrowed template policies are rejected.
tachyonApp(app, { htmlWhitespace: literalTemplatePolicy });
// @ts-expect-error Control-flow-narrowed template policies are rejected.
void renderRoute(routes, "/", { htmlWhitespace: mutableTemplatePolicy });
// @ts-expect-error Partial mixed unions are rejected.
createWorkersHandler({ routes, htmlWhitespace: partialMixed });
// @ts-expect-error Legacy literals are rejected by Node.
createNodeHandler({ routes, htmlWhitespace: "condense" });
// @ts-expect-error Template policies are rejected by Lambda.
createLambdaHandler({ routes, htmlWhitespace: literalTemplatePolicy });
// @ts-expect-error Legacy literals are rejected by Lambda streaming.
createLambdaStreamingHandler({ routes, htmlWhitespace: "preserve" });
`;

try {
  await execFileAsync("pnpm", ["pack", "--pack-destination", directory], { cwd: projectRoot });
  const tarballName = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not create a tarball.");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await execFileAsync("pnpm", ["add", "--ignore-workspace", path.join(directory, tarballName)], { cwd: consumer });
  const usageFile = path.join(consumer, "usage.ts");
  await writeFile(usageFile, source);
  const installedRoot = await realpath(path.join(consumer, "node_modules/tachyon-dom"));
  if (installedRoot.startsWith(projectRoot))
    throw new Error("Type probe resolved the workspace instead of the packed package.");
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
  const runtimeFile = path.join(consumer, "trusted-html.mjs");
  await writeFile(
    runtimeFile,
    `import { escapeToHtml, trustedHtmlChunk } from "tachyon-dom/router";
import { sanitizeHtml } from "tachyon-dom/security";
const escaped = trustedHtmlChunk(escapeToHtml("<img src=x onerror=alert(1)>"));
if (escaped !== "&lt;img src=x onerror=alert(1)&gt;") throw new Error("Escaping helper was not usable from package exports.");
if (!trustedHtmlChunk(sanitizeHtml("<b>safe</b>")).includes("<b>safe</b>")) throw new Error("Sanitized TrustedHtml was not accepted.");
let rejected = false;
try { trustedHtmlChunk({ __tachyonTrustedHtml: true, value: "<img>" }); } catch { rejected = true; }
if (!rejected) throw new Error("Forged TrustedHtml was accepted.");
`,
  );
  await execFileAsync(process.execPath, [runtimeFile], { cwd: consumer });
  console.log(`Installed package whitespace policy declarations verified from ${installedRoot}.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
