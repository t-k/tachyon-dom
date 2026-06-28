import { describe, expect, it } from "vitest";
import { attr, booleanAttr, classList, html, join, rawHtml } from "../src/server/html";

describe("server html helper", () => {
  it("escapes text interpolation by default", () => {
    const view = html`<p>${`<Ada & "Grace">`}</p>`;

    expect(String(view)).toBe("<p>&lt;Ada &amp; &quot;Grace&quot;&gt;</p>");
  });

  it("escapes direct attribute interpolation in attribute context", () => {
    const view = html`<input value=${`"x" & <y>`} />`;

    expect(String(view)).toBe(`<input value="&quot;x&quot; &amp; &lt;y&gt;" />`);
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
});
