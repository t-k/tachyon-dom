import { describe, expect, it } from "vitest";
import { attr, booleanAttr, classList, html, join, rawHtml } from "../src/server/html";

describe("server html helper", () => {
  const activeUrlCorpus = [
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
  ];

  it("escapes text interpolation by default", () => {
    const view = html`<p>${`<Ada & "Grace">`}</p>`;

    expect(String(view)).toBe("<p>&lt;Ada &amp; &quot;Grace&quot;&gt;</p>");
  });

  it("escapes direct attribute interpolation in attribute context", () => {
    const view = html`<input value=${`"x" & <y>`} />`;

    expect(String(view)).toBe(`<input value="&quot;x&quot; &amp; &lt;y&gt;" />`);
  });

  it("keeps direct attribute interpolation inside one parsed attribute", () => {
    document.body.innerHTML = String(html`<img src=${`x onerror=alert(1)`} />`);
    const image = document.body.firstElementChild;

    expect(image?.getAttributeNames()).toEqual(["src"]);
    expect(image?.getAttribute("src")).toBe("x onerror=alert(1)");
  });

  it.each([" ", "\t", "\n", "=", "`", '"', "'", "&", "<", ">"])(
    "rejects interpolation inside an unquoted attribute containing %j",
    (token) => {
      expect(() => html`<img src=/assets/${`x${token}onerror=alert(1)`}.png>`).toThrow(
        "Interpolation inside an unquoted attribute value is not supported; quote the complete value",
      );
    },
  );

  it("rejects an automatically quoted value followed by an unquoted suffix", () => {
    const strings = ["<img src=", ".png>"] as unknown as TemplateStringsArray;

    expect(() => html(strings, "avatar")).toThrow(
      "Interpolated attribute values with literal suffixes must be quoted in the template",
    );
  });

  it("rejects trusted fragments outside their intended HTML context", () => {
    expect(() => html`<div title="${rawHtml(`x" onmouseover="alert(1)`)}"></div>`).toThrow(
      "Trusted HTML fragments can only be interpolated in text context",
    );
    expect(() => html`<p>${attr("data-value", "x")}</p>`).toThrow(
      "Attribute fragments can only be interpolated inside an opening tag",
    );
  });

  it("escapes single quotes in quoted attribute interpolation", () => {
    const strings = [`<a href='`, `'>link</a>`] as unknown as TemplateStringsArray;
    const view = html(strings, `' onmouseover='alert(1)`);

    expect(String(view)).toBe(`<a href='&#39; onmouseover=&#39;alert(1)'>link</a>`);
  });

  it("renders optional attributes, boolean attributes, classes, nested fragments, and lists", () => {
    const view = html`<section${attr("data-name", "Ada & Lin")}${attr("hidden", null)}${booleanAttr(
      "aria-busy",
      false,
    )} class=${classList("card", false, ["primary", undefined])}>
      ${join([html`<p>${"safe <text>"}</p>`, rawHtml("<p>trusted</p>")])}
    </section>`;

    expect(String(view)).toBe(`<section data-name="Ada &amp; Lin" class="card primary">
      <p>safe &lt;text&gt;</p><p>trusted</p>
    </section>`);
  });

  it("rejects unsafe attribute names", () => {
    expect(() => attr(`onload="alert(1)`, "x")).toThrow("Invalid attribute name");
  });

  it.each(["onclick", "ONLOAD", "srcdoc", "innerhtml", "outerhtml"])(
    "rejects dangerous attribute %s in direct HTML helpers",
    (name) => {
      for (const value of ["value", null, false, true]) {
        expect(() => attr(name, value)).toThrow(`Dangerous attribute is not supported: ${name}`);
      }
      for (const enabled of [false, true]) {
        expect(() => booleanAttr(name, enabled)).toThrow(`Dangerous attribute is not supported: ${name}`);
      }
    },
  );

  it.each(activeUrlCorpus)("rejects active URL %j in direct HTML attributes", (value) => {
    for (const name of ["href", "src", "action", "formaction", "xlink:href"]) {
      expect(() => attr(name, value)).toThrow(`Unsafe URL for ${name}`);
    }
    expect(() => html`<a href=${value}>link</a>`).toThrow("Unsafe URL for href");
    expect(() => html`<a href="${value}">link</a>`).toThrow("Unsafe URL for href");
  });

  it.each(["/relative", "#fragment", "mailto:user@example.test", "tel:+12025550123", "https://example.test/a"])(
    "allows contextual navigation URL %j in direct HTML attributes",
    (value) => {
      expect(String(attr("href", value))).toContain(value);
    },
  );

  it("requires direct URL interpolation to provide the complete attribute value", () => {
    expect(() => html`<a href="/users/${"profile"}">profile</a>`).toThrow(
      "URL attribute interpolation must provide the complete value",
    );
    expect(() => html`<a href="${"/users"}/profile">profile</a>`).toThrow(
      "URL attribute interpolation must provide the complete value",
    );
  });
});
