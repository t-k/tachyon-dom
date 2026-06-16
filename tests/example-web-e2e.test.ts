import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let page: Page | undefined;

const baseUrl = (): string => {
  const localUrl = server?.resolvedUrls?.local.find((url) => url.startsWith("http://127.0.0.1"));
  if (!localUrl) {
    throw new Error("Missing Vite local URL.");
  }
  return localUrl.replace(/\/$/, "");
};

describe("browser hydration boundary example", () => {
  beforeAll(async () => {
    server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
      },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 30000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await server?.close();
  });

  it("preserves SSR HTML, hydrates events lazily, and keeps store/list state consistent", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    await page.goto(`${baseUrl()}/examples/web/`, { waitUntil: "networkidle" });

    const htmlBefore = await page.locator("#preview main").evaluate((node) => node.innerHTML);
    expect(htmlBefore).toContain("<!--tachyon-hydrate:counter-panel:start-->");
    expect(await page.locator("#metric-count").textContent()).toBe("7");
    expect(await page.locator("#metric-rows").textContent()).toBe("3");
    expect(await page.locator("#metric-hydrated").textContent()).toBe("no");

    await page.locator("#boundary-button").click();
    expect(await page.locator("#metric-count").textContent()).toBe("7");

    await page.locator("#hydrate").click();
    const htmlAfterHydrate = await page.locator("#preview main").evaluate((node) => node.innerHTML);
    expect(htmlAfterHydrate).toBe(htmlBefore);
    expect(await page.locator("#metric-hydrated").textContent()).toBe("yes");

    await page.locator("#boundary-button").click();
    await page.locator("#prepend").click();

    expect(await page.locator("#metric-count").textContent()).toBe("8");
    expect(await page.locator("#metric-rows").textContent()).toBe("4");
    expect(await page.locator(".preview li").first().textContent()).toContain("Inserted row 4");
  }, 30000);
});
