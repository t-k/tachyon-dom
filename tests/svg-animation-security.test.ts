import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  generateServerModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../src/compiler";
import { setAttributeValue } from "../src/runtime/attr";
import { attr, html } from "../src/server/html";
import { sanitizeElementUrlAttributes } from "../src/url-policy";

const unsafeTargets = [
  "href",
  "xlink:href",
  "custom:href",
  "src",
  "action",
  "formaction",
  "data",
  "poster",
  "srcset",
  "content",
  "http-equiv",
  "style",
  "attributeName",
  "onclick",
  "srcdoc",
  "innerHTML",
  "outerHTML",
  " HREF ",
];
const animationElements = ["set", "animate", "animateMotion", "animateTransform"];

describe("SVG animation security boundaries", () => {
  it("returns actionable diagnostics without changing safe attribute values", () => {
    expect(sanitizeElementUrlAttributes("SET", { attributeName: " opacity ", to: "0.5" })).toEqual({
      ok: true,
      value: { attributeName: " opacity ", to: "0.5" },
    });
    const unsafe = sanitizeElementUrlAttributes("set", { attributeName: "href" });
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) {
      expect(unsafe.error.attribute).toBe("attributeName");
      expect(unsafe.error.message).toBe("Unsafe SVG animation target.");
    }
    expect(compileTemplate('<div attributeName="href"></div>').ok).toBe(true);
    expect(compileTemplate('<div attributeName={label}></div>').ok).toBe(true);
    for (const source of [
      "<svg><set attributeName to={value}/></svg>",
      "<svg><set attributeName={target} to={value}/></svg>",
    ]) {
      const result = compileTemplate(source);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.message).toBe("SVG animation attributeName must be a static safe attribute name.");
    }
  });

  it("matches native case folding for HTML but not XHTML attribute replacement", () => {
    const htmlNode = document.createElement("meta");
    htmlNode.setAttribute("http-equiv", "refresh");
    htmlNode.setAttribute("content", "0;url=javascript:alert(1)");
    setAttributeValue(htmlNode, "CONTENT", "0;url=/safe");
    expect(htmlNode.getAttribute("content")).toBe("0;url=/safe");
    const xml = new DOMParser().parseFromString(
      '<meta xmlns="http://www.w3.org/1999/xhtml" http-equiv="refresh" content="0;url=javascript:alert(1)"/>',
      "application/xhtml+xml",
    );
    expect(() => setAttributeValue(xml.documentElement, "CONTENT", "0;url=/safe")).toThrow();
    expect(xml.documentElement.hasAttribute("CONTENT")).toBe(false);
  });

  it.each(animationElements)("rejects sensitive targets on %s in the shared policy", (tag) => {
    for (const target of unsafeTargets) {
      expect(sanitizeElementUrlAttributes(tag, { attributeName: target, to: "javascript:alert(1)" }).ok, target).toBe(
        false,
      );
    }
    expect(sanitizeElementUrlAttributes(tag, { ATTRIBUTENAME: "href" }).ok).toBe(false);
    expect(sanitizeElementUrlAttributes(tag, { attributeName: "opacity", ATTRIBUTENAME: "href" }).ok).toBe(false);
  });

  it.each(animationElements)("rejects sensitive and dynamic %s targets before generating any target", (tag) => {
    for (const target of unsafeTargets) {
      const result = compileTemplate(`<svg><${tag} attributeName="${target}" to={value}/></svg>`);
      expect(result.ok, target).toBe(false);
    }
    for (const target of ["{target}", '"h&#114;ef"', '""']) {
      expect(compileTemplate(`<svg><${tag} attributeName=${target} values={value}/></svg>`).ok).toBe(false);
    }
    expect(compileTemplate(`<svg><${tag} attributeName="opacity" attributeName="href" to={value}/></svg>`).ok).toBe(
      false,
    );
  });

  it("checks complete helper markup, including entity decoding and fragments", () => {
    expect(() => html`<svg><set attributeName="href" to=${"javascript:alert(1)"}></set></svg>`).toThrow();
    expect(
      () => html`<svg><animate attributeName="h&#114;ef" values=${"/safe;javascript:alert(1)"}></animate></svg>`,
    ).toThrow();
    expect(() => html`<svg><set ${attr("attributeName", "href")} to="/safe"></set></svg>`).toThrow();
    expect(() => html`<svg><set attributeName=${"href"} to="/safe"></set></svg>`).toThrow();
  });

  it("rejects DOM changes before mutation in either attribute order", () => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "set");
    setAttributeValue(node, "to", "javascript:alert(1)");
    expect(() => setAttributeValue(node, "attributeName", "href")).toThrow();
    expect(node.hasAttribute("attributeName")).toBe(false);
    node.setAttribute("attributeName", "href");
    expect(() => setAttributeValue(node, "to", "javascript:alert(2)")).toThrow();
    expect(node.getAttribute("to")).toBe("javascript:alert(1)");
  });

  it("preserves case-distinct SVG attributes when validating a prospective change", () => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "set");
    node.setAttribute("attributeName", "href");
    node.setAttribute("to", "javascript:alert(1)");
    expect(() => setAttributeValue(node, "ATTRIBUTENAME", "opacity")).toThrow();
    expect(node.hasAttribute("ATTRIBUTENAME")).toBe(false);
    setAttributeValue(node, "attributeName", "opacity");
    expect(node.getAttribute("attributeName")).toBe("opacity");
  });

  it("preserves ordinary attributes and numeric/color animation across renderers", async () => {
    expect(sanitizeElementUrlAttributes("div", { attributeName: "href" }).ok).toBe(true);
    expect(sanitizeElementUrlAttributes("set", { to: "0.5" }).ok).toBe(true);
    for (const target of ["opacity", "fill", "stroke-width", "viewBox"]) {
      const source = `<svg><rect><animate attributeName="${target}" to={value}/></rect></svg>`;
      const result = compileTemplate(source);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      const expected = `<svg><rect><animate attributeName="${target}" to="0.5"></animate></rect></svg>`;
      expect(renderServerTemplate(result.value, { value: "0.5" })).toBe(expected);
      expect(result.value.client.templateHtml).toContain(`attributeName="${target}"`);
      const load = async (code: string) =>
        import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
      const server = await load(generateServerModule(result.value));
      expect(server.render({ value: "0.5" })).toBe(expected);
      const stream = await load(generateServerStreamModule(result.value));
      let rendered = "";
      for await (const chunk of stream.stream({ value: "0.5" })) rendered += chunk;
      expect(rendered).toBe(expected);
      const node = document.createElementNS("http://www.w3.org/2000/svg", "animate");
      setAttributeValue(node, "attributeName", target);
      setAttributeValue(node, "to", "0.5");
      expect(node.getAttribute("to")).toBe("0.5");
    }
    expect(String(html`<svg><set attributeName="fill" to=${"red"}></set></svg>`)).toContain('to="red"');
  });
});
