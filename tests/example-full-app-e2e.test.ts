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

describe("full app browser example", () => {
  beforeAll(async () => {
    server = await createServer({
      root: "examples/full-app",
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

  it("serves SSR HTML at the dev server root and keeps the hydrated shell mounted", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    const response = await fetch(`${baseUrl()}/`);
    const html = await response.text();
    expect(html).toContain('data-ssr-route="/"');
    expect(html).toContain("Persistent layout with route-level tools");
    expect(html).not.toContain('<main id="app"></main>');

    await page.addInitScript(() => {
      const hits: number[] = [];
      Object.defineProperty(window, "__tachyonEmptyShellHits", { value: hits });
      const observe = (): void => {
        const app = document.querySelector("#app");
        if (app && !app.querySelector("[data-testid='app-shell']")) {
          hits.push(performance.now());
        }
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    });
    await page.goto(`${baseUrl()}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(100);

    expect(await page.getByTestId("route-title").textContent()).toBe("Overview");
    expect(await page.getByTestId("overview-page").textContent()).toContain("Persistent layout");
    expect(
      await page.evaluate(() => (window as unknown as { __tachyonEmptyShellHits: number[] }).__tachyonEmptyShellHits),
    ).toEqual([]);
  }, 30000);

  it("opens from the root URL and exercises counter, forms, and compiler pages", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    await page.goto(`${baseUrl()}/`, { waitUntil: "networkidle" });

    await page.getByRole("link", { name: "Counter" }).click();
    await page.getByTestId("increment").click();
    await page.getByTestId("double-step").click();
    expect(await page.getByTestId("count-value").textContent()).toBe("1");
    expect(await page.getByTestId("projected-value").textContent()).toBe("5");
    expect(page.url()).toBe(`${baseUrl()}/counter/`);

    await page.getByRole("link", { name: "Forms" }).click();
    await page.getByLabel("Display name").fill("Root User");
    await page.getByLabel("Email").fill("root@example.com");
    await page.getByLabel("Role").selectOption("Router");
    await page.getByTestId("save-profile").click();
    expect(await page.getByTestId("profile-email").textContent()).toBe("root@example.com");

    await page.getByRole("link", { name: "Compiler" }).click();
    expect(await page.getByTestId("stream-output").textContent()).toContain("<section");
    expect(await page.getByTestId("generated-client").textContent()).toContain("mountKeyedList");
  }, 30000);
});
