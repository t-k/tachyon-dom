// @vitest-environment node

import { chromium, type Browser } from "playwright";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileTemplate, renderServerTemplate } from "../src/compiler";
import { compileTachyonSfc } from "../src/compiler/sfc";
import { textAt } from "../src/runtime/text";

let browser: Browser | undefined;
let textRuntimeSource = "";

describe("open issue browser regressions", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL("../src/runtime/text.ts", import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "TachyonTextTest",
      define: { __TACHYON_PRODUCTION__: "true" },
      write: false,
    });
    textRuntimeSource = bundled.outputFiles?.[0]?.text ?? "";
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
      await page.addScriptTag({ content: textRuntimeSource });
      const result = await page.evaluate(
        ({ path }) => {
          const runtime = (
            globalThis as typeof globalThis & {
              TachyonTextTest: {
                textAt: (root: Node, path: readonly number[]) => Text;
                setText: (text: Text, value: unknown) => void;
              };
            }
          ).TachyonTextTest;
          const root = document.querySelector("p");
          if (!root) throw new Error("Missing browser root.");
          const text = runtime.textAt(root, path);
          const initial = root.textContent;
          runtime.setText(text, "Z");
          return { initial, updated: root.textContent, nodeType: text.nodeType };
        },
        { path: binding.path },
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
        const runtime = (
          globalThis as unknown as {
            TDClassFixture: {
              setAttributeValue: (element: Element, name: string, value: unknown) => void;
              setClassPresence: (element: Element, name: string, value: unknown) => void;
            };
          }
        ).TDClassFixture;
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

  it("prevents unsafe head URLs during a real browser client navigation", async () => {
    const bundle = await build({
      stdin: {
        contents: `export { createClientRouter } from "./src/runtime/router.ts";`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      format: "iife",
      globalName: "TDRouterFixture",
      platform: "browser",
      write: false,
    });
    const script = bundle.outputFiles[0]?.text;
    if (!script) throw new Error("Missing client router bundle.");
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.route("http://tachyon.test/**", async (route) =>
        route.fulfill({ contentType: "text/html", body: `<main id="app"></main>` }),
      );
      await page.goto("http://tachyon.test/");
      await page.addScriptTag({ content: script });
      const result = await page.evaluate(async () => {
        const probeGlobal = globalThis as typeof globalThis & { __headProbe: number };
        probeGlobal.__headProbe = 0;
        const runtime = (
          globalThis as unknown as {
            TDRouterFixture: {
              createClientRouter: (options: Record<string, unknown>) => {
                start: () => Promise<void>;
                navigate: (href: string) => Promise<void>;
                dispose: () => void;
              };
            };
          }
        ).TDRouterFixture;
        const root = document.querySelector("#app");
        if (!(root instanceof HTMLElement)) throw new Error("Missing router root.");
        const router = runtime.createClientRouter({
          root,
          routes: [
            { path: "/", render: () => "Home" },
            {
              path: "/unsafe",
              head: () => ({
                metas: [{ "http-equiv": "refresh", content: "0;url=javascript:alert(1)" }],
                links: [
                  { rel: "stylesheet", href: "data:text/css,body{}", "data-id": "unsafe-link" },
                  { rel: "stylesheet", href: "/safe.css", "data-id": "safe-link" },
                ],
                scripts: [
                  {
                    src: "data:text/javascript,globalThis.__headProbe=1",
                    "data-id": "unsafe-script",
                  },
                ],
              }),
              render: () => "Unsafe",
            },
          ],
          scrollTo: () => undefined,
        });
        await router.start();
        await router.navigate("/unsafe");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const observed = {
          probe: probeGlobal.__headProbe,
          unsafeLink: document.head.querySelector(`[data-id="unsafe-link"]`) !== null,
          unsafeScriptSrc: document.head.querySelector(`[data-id="unsafe-script"]`)?.hasAttribute("src"),
          metaContent: document.head.querySelector(`meta[http-equiv="refresh"]`)?.hasAttribute("content"),
          safeLink: document.head.querySelector(`[data-id="safe-link"]`)?.getAttribute("href"),
        };
        router.dispose();
        return observed;
      });

      expect(result).toEqual({
        probe: 0,
        unsafeLink: false,
        unsafeScriptSrc: false,
        metaContent: false,
        safeLink: "/safe.css",
      });
    } finally {
      await page.close();
    }
  });
});
