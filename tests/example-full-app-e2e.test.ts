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

  it("serves SSR HTML for every page and keeps the hydrated shell mounted", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    const pages = [
      { path: "/", title: "Overview", marker: "Persistent layout with route-level tools" },
      { path: "/counter/", title: "Counter", marker: "Projected value is count plus two steps." },
      { path: "/lists/", title: "Lists", marker: "Compiler bindings" },
      { path: "/forms/", title: "Forms", marker: "guest@example.com" },
      { path: "/compiler/", title: "Compiler", marker: "mountKeyedList" },
      { path: "/settings/", title: "Settings", marker: "Comfortable" },
    ];

    for (const route of pages) {
      const response = await fetch(`${baseUrl()}${route.path}`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`data-ssr-route="${route.path}"`);
      expect(html).toContain(`<h1 data-testid="route-title">${route.title}</h1>`);
      expect(html).toContain(route.marker);
      expect(html).not.toContain('<main id="app"></main>');
    }

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

  it("hydrates each directly served SSR page without losing the route", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    const pages = [
      { path: "/", title: "Overview", marker: "Persistent layout" },
      { path: "/counter/", title: "Counter", marker: "Projected value" },
      { path: "/lists/", title: "Lists", marker: "Compiler bindings" },
      { path: "/forms/", title: "Forms", marker: "guest@example.com" },
      { path: "/compiler/", title: "Compiler", marker: "mountKeyedList" },
      { path: "/settings/", title: "Settings", marker: "Comfortable" },
    ];

    for (const route of pages) {
      await page.goto(`${baseUrl()}${route.path}`, { waitUntil: "networkidle" });
      expect(await page.getByTestId("route-title").textContent()).toBe(route.title);
      expect(await page.locator("#route-outlet").textContent()).toContain(route.marker);
    }
  }, 30000);
});
