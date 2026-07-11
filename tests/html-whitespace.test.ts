import { describe, expect, it } from "vitest";
import { parse, serialize } from "parse5";

import { condenseHtmlWhitespace, defineApp, minifyHtml, normalizeHtmlTagWhitespace } from "../src/app.js";
import { applyHtmlWhitespace } from "../src/html-whitespace.js";
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
  it("maps legacy runtime literals explicitly and rejects unknown policies", () => {
    const source = `<div   class="x"   >ok</div>`;
    expect(applyHtmlWhitespace(source, "condense" as never)).toBe(`<div class="x">ok</div>`);
    expect(applyHtmlWhitespace(source, "preserve" as never)).toBe(source);
    for (const policy of ["typo", "", null]) {
      expect(() => applyHtmlWhitespace(source, policy as never)).toThrow(/HTML whitespace policy.*migration/i);
    }
  });

  it("keeps deprecated minify names as tag-normalization aliases", () => {
    const source = `<ul   class="items"   >\n    <li>one</li>\n    <li>two</li>\n</ul>`;
    const expected = `<ul class="items">\n    <li>one</li>\n    <li>two</li>\n</ul>`;

    expect(normalizeHtmlTagWhitespace(source)).toBe(expected);
    expect(condenseHtmlWhitespace(source)).toBe(expected);
    expect(minifyHtml(source)).toBe(expected);
  });

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
    expect(output).toContain(`<meta charset="UTF-8" />`);

    expect(bodySource(output)).toBe(bodySource(source));
  });

  it("supports a typed app policy while retaining the boolean compatibility alias", () => {
    const app = defineApp({
      shell: ({ routeHtml }) => `<main   id="app">${routeHtml}</main>`,
      pages: [
        {
          path: "/",
          fileName: "index.html",
          template: `<main><section hydrate:id={id}>Hello {name}!</section><span>Hello </span><strong>world</strong></main>`,
          scope: { id: "account", name: "Ada" },
        },
      ],
    });

    const preserved = app.renderDocument("/", { whitespace: "preserve-tags" });
    const condensed = app.renderDocument("/", { whitespace: "normalize-tags" });
    expect(condensed).toBe(app.renderDocument("/", { minify: true }));
    expect(condensed).not.toBe(preserved);
    expect(serialize(parse(condensed))).toBe(serialize(parse(preserved)));
    expect(app.renderDocument("/", { whitespace: "condense" as never })).toBe(condensed);
    expect(() => app.renderDocument("/", { whitespace: "typo" as never })).toThrow(/HTML whitespace policy/);
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
    const buffered = await renderRoute(routes, "https://example.test/", { htmlWhitespace: "normalize-tags" });
    expect(buffered.ok).toBe(true);
    if (!buffered.ok) return;
    expect(buffered.value.html).toContain("\n  <head>");
    expect(buffered.value.html).toContain("<!---->Ada<!---->");
    const legacyBuffered = await renderRoute(routes, "https://example.test/", {
      htmlWhitespace: "condense" as never,
    });
    expect(legacyBuffered).toEqual(buffered);

    const streamed = await renderRouteStream(routes, "https://example.test/", { htmlWhitespace: "normalize-tags" });
    expect(streamed.ok).toBe(true);
    if (!streamed.ok) return;
    const chunks: string[] = [];
    for await (const chunk of streamed.value.chunks) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain("<p>  Loading  </p>");
    expect(chunks.join("")).toContain("\n  <head>");

    await expect(
      renderRouteStream(routes, "https://example.test/", { htmlWhitespace: "typo" as never }),
    ).rejects.toThrow(/HTML whitespace policy/);
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

  it("preserves unquoted self-closing values, raw-text lookalikes, and less-than text", () => {
    expect(minifyHtml(`<input   value=x />`)).toBe(`<input value=x />`);
    expect(minifyHtml(`<script>const x="</scripture>"; const y="<div   data-x=y>";</script>`)).toBe(
      `<script>const x="</scripture>"; const y="<div   data-x=y>";</script>`,
    );
    expect(minifyHtml(`<p>a < b > c</p>`)).toBe(`<p>a < b > c</p>`);
  });

  it("fails closed for incomplete comments, quotes, CDATA, and raw-text end-tag lookalikes", () => {
    for (const source of [
      `<div   title="unterminated>`,
      `<p   x=y><!-- unclosed >`,
      `<svg><![CDATA[x > <g   id=x> ]]></svg>`,
      `<textarea>a</textareax><b   x=y></textarea>`,
    ]) {
      expect(minifyHtml(source)).toBe(source);
    }
  });

  it("does not treat Unicode whitespace inside unquoted values as HTML attribute separators", () => {
    for (const whitespace of ["\u00a0", "\u2003", "\u2028"]) {
      expect(minifyHtml(`<div   title=a${whitespace}b></div>`)).toBe(`<div title=a${whitespace}b></div>`);
    }
  });
});
