import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { html } from "../src/server/html";

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
});
