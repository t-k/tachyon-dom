import { describe, expect, it } from "vitest";

import { defineApp, minifyHtml } from "../src/app.js";
import { renderRoute, renderRouteStream } from "../src/router.js";

const meaningfulBody = `<main id="app">
  <!--tachyon-hydrate:account:start--><p>Hello <!---->Ada<!---->!</p><!--tachyon-hydrate:account:end-->
  <span>Hello </span><strong>world</strong>
  <textarea>  keep\n this  </textarea>
  <script type="application/json">{ "space": "a  b" }</script>
  <style>.x::after { content: "a  b"; }</style>
</main>`;

const bodySource = (html: string): string =>
  html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("</body>"));

describe("safe HTML whitespace policy", () => {
  it("condenses document framing without changing body semantics or Tachyon anchors", () => {
    const source = `<!doctype html>
<html>
  <head>
    <meta   charset="UTF-8"   />
    <title>  Keep title spacing  </title>
  </head>
  <body>
    ${meaningfulBody}
  </body>
</html>`;

    const output = minifyHtml(source);

    expect(output).toContain("<!--tachyon-hydrate:account:start-->");
    expect(output).toContain("<!---->Ada<!---->");
    expect(output).toContain(`<span>Hello </span><strong>world</strong>`);
    expect(output).toContain(`<textarea>  keep\n this  </textarea>`);
    expect(output).toContain(`<script type="application/json">{ "space": "a  b" }</script>`);
    expect(output).toContain(`<style>.x::after { content: "a  b"; }</style>`);
    expect(output).toContain(`<meta charset="UTF-8"/>`);

    expect(bodySource(output)).toBe(bodySource(source));
  });

  it("supports a typed app policy while retaining the boolean compatibility alias", () => {
    const app = defineApp({
      pages: [
        {
          path: "/",
          fileName: "index.html",
          template: `<main><section hydrate:id={id}>Hello {name}!</section><span>Hello </span><strong>world</strong></main>`,
          scope: { id: "account", name: "Ada" },
        },
      ],
    });

    const preserved = app.renderDocument("/", { whitespace: "preserve" });
    const condensed = app.renderDocument("/", { whitespace: "condense" });
    expect(condensed).toBe(app.renderDocument("/", { minify: true }));
    expect(condensed).not.toBe(preserved);
    expect(bodySource(condensed)).toBe(bodySource(preserved));
  });

  it("opts buffered routes into the same policy and leaves streaming chunks untouched", async () => {
    const routes = [
      {
        path: "/",
        fallback: "<p>  Loading  </p>",
        render: () =>
          `<!doctype html>\n<html>\n  <head><title>x</title></head>\n  <body>${meaningfulBody}</body>\n</html>`,
      },
    ];
    const buffered = await renderRoute(routes, "https://example.test/", { htmlWhitespace: "condense" });
    expect(buffered.ok).toBe(true);
    if (!buffered.ok) return;
    expect(buffered.value.html).toContain("\n  <head>");
    expect(buffered.value.html).toContain("<!---->Ada<!---->");

    const streamed = await renderRouteStream(routes, "https://example.test/", { htmlWhitespace: "condense" });
    expect(streamed.ok).toBe(true);
    if (!streamed.ok) return;
    const chunks: string[] = [];
    for await (const chunk of streamed.value.chunks) chunks.push(chunk);
    expect(chunks[0]).toBe("<p>  Loading  </p>");
    expect(chunks.join("")).toContain("\n  <head>");
  });

  it("preserves comments, foreign content, quoted values, and malformed input", () => {
    const source = `<!--ordinary--><!--[if IE]>legacy<![endif]--><svg viewBox="0  0  10  10"><text>a  b</text></svg><math><mi>x</mi></math><div   title="a  b"   ></div>`;
    const output = minifyHtml(source);

    expect(output).toContain("<!--ordinary-->");
    expect(output).toContain("<!--[if IE]>legacy<![endif]-->");
    expect(output).toContain(`<svg viewBox="0  0  10  10"><text>a  b</text></svg>`);
    expect(output).toContain("<math><mi>x</mi></math>");
    expect(output).toContain(`<div title="a  b"></div>`);
    expect(minifyHtml(output)).toBe(output);
    expect(minifyHtml(`<div title="unterminated"`)).toBe(`<div title="unterminated"`);
  });
});
