import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  }, 30000);

  beforeEach(async () => {
    if (!browser) {
      throw new Error("Missing browser.");
    }
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("preserves SSR HTML, hydrates events lazily, and keeps store/list state consistent", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl()}/examples/web/`, { waitUntil: "networkidle" });

    const htmlBefore = await page
      .getByTestId("preview")
      .locator("main")
      .evaluate((node) => node.innerHTML);
    expect(htmlBefore).toContain("<!--tachyon-hydrate:counter-panel:start-->");
    expect(await page.getByTestId("metric-count").textContent()).toBe("7");
    expect(await page.getByTestId("metric-rows").textContent()).toBe("3");
    expect(await page.getByTestId("metric-hydrated").textContent()).toBe("no");
    await expectGeneratedPanels(page);

    await page.getByTestId("boundary-button").click();
    expect(await page.getByTestId("metric-count").textContent()).toBe("7");

    await page.getByTestId("hydrate").click();
    const htmlAfterHydrate = await page
      .getByTestId("preview")
      .locator("main")
      .evaluate((node) => node.innerHTML);
    expect(htmlAfterHydrate).toBe(htmlBefore);
    expect(await page.getByTestId("metric-hydrated").textContent()).toBe("yes");

    await page.getByTestId("boundary-button").click();
    await page.getByTestId("prepend").click();

    expect(await page.getByTestId("metric-count").textContent()).toBe("8");
    expect(await page.getByTestId("metric-rows").textContent()).toBe("4");
    expect(await page.getByTestId("preview").locator("li").first().textContent()).toContain("Inserted row 4");
  }, 30000);

  it("keeps the specification app usable on a mobile viewport", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl()}/examples/web/`, { waitUntil: "networkidle" });

    await page.getByTestId("hydrate").click();
    await page.getByTestId("increment").click();
    await page.getByTestId("prepend").click();

    expect(await page.getByTestId("metric-count").textContent()).toBe("8");
    expect(await page.getByTestId("metric-rows").textContent()).toBe("4");
    const previewBox = await page.getByTestId("preview").boundingBox();
    expect(previewBox?.width).toBeGreaterThan(300);
    await expectGeneratedPanels(page);
  }, 30000);
});

const expectGeneratedPanels = async (page: Page): Promise<void> => {
  expect(await page.getByTestId("generated-client").textContent()).toContain(`mountConditional`);
  expect(await page.getByTestId("compiler-ir").textContent()).toContain(`"kind": "component"`);
  expect(await page.getByTestId("stream-chunks").textContent()).toContain(`tachyon-hydrate:counter-panel:start`);
};
