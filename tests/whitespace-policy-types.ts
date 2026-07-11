import { defineApp, renderAppDocument, type HtmlWhitespacePolicy } from "../src/app";
import { createLambdaHandler, createLambdaStreamingHandler } from "../src/adapters/lambda";
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
const literalTemplatePolicy: TemplateWhitespacePolicy = "condense";
let mutableTemplatePolicy: TemplateWhitespacePolicy = "preserve";
if (Math.random() > 0.5) mutableTemplatePolicy = "condense";
const partialMixed: "condense" | "normalize-tags" = Math.random() > 0.5 ? "condense" : "normalize-tags";

app.renderDocument("/", { whitespace: "preserve-tags" });
renderAppDocument(app, "/", { whitespace: "normalize-tags" });
tachyonApp(app, { htmlWhitespace: htmlPolicy });
void renderRoute(routes, "/", { htmlWhitespace: "preserve-tags" });
createWorkersHandler({ routes, htmlWhitespace: htmlPolicy });
createNodeHandler({ routes, htmlWhitespace: "normalize-tags" });
createLambdaHandler({ routes, htmlWhitespace: htmlPolicy });
createLambdaStreamingHandler({ routes, htmlWhitespace: "preserve-tags" });

// @ts-expect-error Legacy literals are not tag-normalization policies.
app.renderDocument("/", { whitespace: "condense" });
// @ts-expect-error Legacy literals are not tag-normalization policies.
renderAppDocument(app, "/", { whitespace: "preserve" });
// @ts-expect-error Literal-narrowed template policies remain semantically distinct.
tachyonApp(app, { htmlWhitespace: literalTemplatePolicy });
// @ts-expect-error Control-flow-narrowed template policies remain semantically distinct.
void renderRoute(routes, "/", { htmlWhitespace: mutableTemplatePolicy });
// @ts-expect-error Partial mixed unions cannot cross the policy boundary.
createWorkersHandler({ routes, htmlWhitespace: partialMixed });
// @ts-expect-error Legacy literals are not accepted by Node adapters.
createNodeHandler({ routes, htmlWhitespace: "condense" });
// @ts-expect-error Literal-narrowed template policies are rejected by Lambda adapters.
createLambdaHandler({ routes, htmlWhitespace: literalTemplatePolicy });
// @ts-expect-error Legacy literals are rejected by Lambda streaming adapters.
createLambdaStreamingHandler({ routes, htmlWhitespace: "preserve" });
