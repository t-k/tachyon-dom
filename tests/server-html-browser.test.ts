import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attr, html } from "../src/server/html";

let browser: Browser | undefined;

describe("server HTML browser security", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("keeps an interpolated payload inside one quoted attribute", async () => {
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      const markup = String(html`<img id="subject" src=${`x onerror=globalThis.__tachyonXss = true`} />`);
      await page.setContent(markup);

      expect(await page.locator("#subject").evaluate((element) => element.getAttributeNames())).toEqual(["id", "src"]);
      expect(await page.locator("#subject").getAttribute("src")).toBe("x onerror=globalThis.__tachyonXss = true");
      expect(await page.evaluate(() => "__tachyonXss" in globalThis)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("rejects active navigation schemes before browser parsing", async () => {
    expect(() => html`<a href=${"java\tscript:globalThis.__tachyonXss = true"}>unsafe</a>`).toThrow(
      "Unsafe URL for href",
    );

    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      const markup = String(html`<a id="subject" href=${"/safe onclick=globalThis.__tachyonXss = true"}>safe</a>`);
      await page.setContent(markup);

      expect(await page.locator("#subject").evaluate((element) => element.getAttributeNames())).toEqual(["id", "href"]);
      expect(await page.locator("#subject").getAttribute("href")).toBe("/safe onclick=globalThis.__tachyonXss = true");
      expect(await page.evaluate(() => "__tachyonXss" in globalThis)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("rejects static and fragment-built active URLs before browser navigation", async () => {
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent(`<a id="subject" href="/safe">safe</a>`);
      expect(() => html`<a href="jav&#x61;script:globalThis.__tachyonStaticXss = true">unsafe</a>`).toThrow(
        "Unsafe URL for href",
      );
      expect(() => html`<meta http-equiv="refresh" ${attr("content", "0;url=//evil.example")} />`).toThrow(
        "Unsafe URL for content",
      );
      expect(
        () => html`<textarea>${html`</textarea>`}<a href="javascript:globalThis.__tachyonStaticXss = true">unsafe</a>`,
      ).toThrow("Unsafe URL for href");
      await page.locator("#subject").click();

      expect(await page.evaluate(() => "__tachyonStaticXss" in globalThis)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("rejects literal event handler interpolation before it can execute", async () => {
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent("<button id=subject>subject</button>");
      expect(() => html`<button onclick=${"globalThis.__tachyonEventXss = true"}>subject</button>`).toThrow(
        "Dangerous attribute is not supported: onclick",
      );
      await page.locator("#subject").click();

      expect(await page.evaluate(() => "__tachyonEventXss" in globalThis)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("rejects literal srcdoc interpolation before iframe scripts can execute", async () => {
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent("<iframe id=subject></iframe>");
      const strings = ["<iframe SRCDOC=", "></iframe>"] as unknown as TemplateStringsArray;
      expect(() => html(strings, "<script>parent.__tachyonSrcdocXss = true</script>")).toThrow(
        "Dangerous attribute is not supported: SRCDOC",
      );
      await page.waitForTimeout(25);

      expect(await page.evaluate(() => "__tachyonSrcdocXss" in globalThis)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("rejects raw-text interpolation before browser parsing", async () => {
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent("<main id=subject>safe</main>");
      expect(
        () =>
          html`<script>
            ${"globalThis.__tachyonRawTextXss = true"};
          </script>`,
      ).toThrow("Interpolation inside <script> raw text is not supported");
      expect(
        () =>
          html`<style>
            ${"* { display: none }"}
          </style>`,
      ).toThrow("Interpolation inside <style> raw text is not supported");

      expect(await page.evaluate(() => "__tachyonRawTextXss" in globalThis)).toBe(false);
      expect(await page.locator("#subject").isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("rejects dangerous literal attributes after interpolation and slash syntax before execution", async () => {
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent("<img id=subject src=/missing>");
      expect(() => html`<img src=${"/missing"} onerror=${"globalThis.__tachyonChainedXss = true"} />`).toThrow(
        "Dangerous attribute is not supported: onerror",
      );
      expect(() => html`<img/onerror=${"globalThis.__tachyonSlashXss = true"}>`).toThrow(
        "Dangerous attribute is not supported: onerror",
      );
      await page.waitForTimeout(25);

      expect(await page.evaluate(() => "__tachyonChainedXss" in globalThis)).toBe(false);
      expect(await page.evaluate(() => "__tachyonSlashXss" in globalThis)).toBe(false);
    } finally {
      await page.close();
    }
  });
});
