import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

describe("keyed rows browser state", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = await createServer({ root: process.cwd(), server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing Vite address");
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/keyed-rows-browser.html`);
  });

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await server?.close();
  });

  it("preserves interactive state without focus events through the native path", async () => {
    expect(await page.evaluate(() => window.runKeyedSwap(false))).toMatchObject({
      active: true,
      selection: [2, 5],
      value: "value-2",
      blur: 0,
      focus: 0,
      inputVisible: true,
      ids: ["1", "3", "2", "4", "5", "6"],
    });
  });

  it("restores focus without scrolling through the fallback path", async () => {
    expect(await page.evaluate(() => window.runKeyedSwap(true))).toEqual({
      active: true,
      selection: [2, 5],
      value: "value-2",
      blur: 1,
      focus: 1,
      scrollTop: 80,
      inputVisible: false,
      ids: ["1", "3", "2", "4", "5", "6"],
    });
  });
});
