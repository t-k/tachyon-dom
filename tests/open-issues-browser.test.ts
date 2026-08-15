// @vitest-environment node

import { chromium, type Browser } from "playwright";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileTemplate, renderServerTemplate } from "../src/compiler";
import { compileTachyonSfc } from "../src/compiler/sfc";
import { setText, textAt } from "../src/runtime/text";

let browser: Browser | undefined;

describe("open issue browser regressions", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each(["", null, undefined])("hydrates empty text value %j without real DOM path drift", async (value) => {
    const result = compileTemplate(`<p>a{value}b</p>`);
    if (!result.ok) throw new Error(result.error.message);
    const markup = renderServerTemplate(result.value, { value });
    const binding = result.value.client.bindings.find((candidate) => candidate.kind === "text");
    if (!binding || binding.kind !== "text") throw new Error("Missing text binding.");
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent(markup);
      const result = await page.evaluate(
        ({ path, setTextSource, textAtSource }) => {
          const resolveText = (0, eval)(`(${textAtSource})`) as typeof textAt;
          const updateText = (0, eval)(`(${setTextSource})`) as typeof setText;
          const root = document.querySelector("p");
          if (!root) throw new Error("Missing browser root.");
          const text = resolveText(root, path);
          const initial = root.textContent;
          updateText(text, "Z");
          return { initial, updated: root.textContent, nodeType: text.nodeType };
        },
        { path: binding.path, setTextSource: setText.toString(), textAtSource: textAt.toString() },
      );

      expect(result).toEqual({ initial: "ab", updated: "aZb", nodeType: 3 });
    } finally {
      await page.close();
    }
  });

  it("preserves a data script after the leading SFC component script", async () => {
    const source = `<script>export const scope = () => ({ title: "Page" });</script><main><script type="application/ld+json">[]</script><h1>{title}</h1></main>`;
    const result = compileTachyonSfc(source);
    if (!result.ok) throw new Error(result.error.message);
    const markup = renderServerTemplate(result.value.template, { title: "Page" });
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent(markup);

      expect(await page.locator('script[type="application/ld+json"]').textContent()).toBe("[]");
      expect(await page.locator("h1").textContent()).toBe("Page");
    } finally {
      await page.close();
    }
  });

  it("normalizes implied table containers before real DOM binding paths are generated", async () => {
    const result = compileTemplate(`<table><tr><td>{value}</td></tr></table>`);
    if (!result.ok) throw new Error(result.error.message);
    const markup = renderServerTemplate(result.value, { value: "A" });
    const binding = result.value.client.bindings.find((candidate) => candidate.kind === "text");
    if (!binding || binding.kind !== "text") throw new Error("Missing table text binding.");
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent(markup);
      const observed = await page.evaluate(
        ({ path, textAtSource }) => {
          const resolveText = (0, eval)(`(${textAtSource})`) as typeof textAt;
          const table = document.querySelector("table");
          if (!table) throw new Error("Missing table.");
          const text = resolveText(table, path);
          text.nodeValue = "B";
          return {
            childName: table.firstElementChild?.tagName,
            text: table.querySelector("tbody td")?.textContent,
          };
        },
        { path: binding.path, textAtSource: textAt.toString() },
      );

      expect(observed).toEqual({ childName: "TBODY", text: "B" });
    } finally {
      await page.close();
    }
  });

  it("retains directive classes after a dynamic base class update in a real DOM", async () => {
    const bundle = await build({
      stdin: {
        contents: `export { setAttributeValue } from "./src/runtime/attr.ts"; export { setClassPresence } from "./src/runtime/class.ts";`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      format: "iife",
      globalName: "TDClassFixture",
      platform: "browser",
      write: false,
    });
    const script = bundle.outputFiles[0]?.text;
    if (!script) throw new Error("Missing class runtime bundle.");
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent("<div id=subject></div>");
      await page.addScriptTag({ content: script });
      const classNames = await page.evaluate(() => {
        const runtime = (globalThis as unknown as {
          TDClassFixture: {
            setAttributeValue: (element: Element, name: string, value: unknown) => void;
            setClassPresence: (element: Element, name: string, value: unknown) => void;
          };
        }).TDClassFixture;
        const element = document.querySelector("#subject");
        if (!(element instanceof HTMLDivElement)) throw new Error("Missing class subject.");
        runtime.setAttributeValue(element, "class", "one");
        runtime.setClassPresence(element, "active", true);
        runtime.setAttributeValue(element, "class", "two");
        const enabled = element.className;
        runtime.setAttributeValue(element, "class", "two active");
        runtime.setClassPresence(element, "active", false);
        const collidingDisabled = element.className;
        runtime.setAttributeValue(element, "class", "active selected");
        return [enabled, collidingDisabled, element.className];
      });

      expect(classNames).toEqual(["two active", "two active", "active selected"]);
    } finally {
      await page.close();
    }
  });
});
