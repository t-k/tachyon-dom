import { defineApp, renderAppDocument, type HtmlWhitespacePolicy, type LegacyHtmlWhitespacePolicy } from "../src/app";
import { createLambdaHandler } from "../src/adapters/lambda";
import { createNodeHandler } from "../src/adapters/node";
import { createWorkersHandler } from "../src/adapters/workers";
import type { TemplateWhitespacePolicy } from "../src/compiler";
import { renderRoute, type RouteDefinition } from "../src/router";
import { tachyonApp } from "../src/vite";

const app = defineApp({
  pages: [{ path: "/", fileName: "index.html", template: "<main>ok</main>", scope: {} }],
});
const routes: RouteDefinition[] = [{ path: "/", render: () => "ok" }];
const htmlPolicy: HtmlWhitespacePolicy = Math.random() > 0.5 ? "preserve-tags" : "normalize-tags";
const templatePolicy: TemplateWhitespacePolicy = Math.random() > 0.5 ? "preserve" : "condense";
const legacyPolicy: LegacyHtmlWhitespacePolicy = templatePolicy;

app.renderDocument("/", { whitespace: "preserve" });
renderAppDocument(app, "/", { whitespace: "condense" });
tachyonApp(app, { htmlWhitespace: "condense" });
void renderRoute(routes, "/", { htmlWhitespace: "preserve" });
createWorkersHandler({ routes, htmlWhitespace: "condense" });
createNodeHandler({ routes, htmlWhitespace: htmlPolicy });
createLambdaHandler({ routes, htmlWhitespace: "preserve" });

// @ts-expect-error Template text policies are not tag-normalization options.
app.renderDocument("/", { whitespace: templatePolicy });
// @ts-expect-error Template text policies are not tag-normalization options.
renderAppDocument(app, "/", { whitespace: templatePolicy });
// @ts-expect-error Template text policies are not tag-normalization options.
tachyonApp(app, { htmlWhitespace: templatePolicy });
// @ts-expect-error Template text policies are not tag-normalization options.
void renderRoute(routes, "/", { htmlWhitespace: templatePolicy });
// @ts-expect-error A widened legacy union is ambiguous; use a direct literal or HtmlWhitespacePolicy.
createWorkersHandler({ routes, htmlWhitespace: legacyPolicy });
// @ts-expect-error A widened legacy union is ambiguous; use a direct literal or HtmlWhitespacePolicy.
createNodeHandler({ routes, htmlWhitespace: legacyPolicy });
// @ts-expect-error A widened legacy union is ambiguous; use a direct literal or HtmlWhitespacePolicy.
createLambdaHandler({ routes, htmlWhitespace: legacyPolicy });
