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

describe("authenticated todo browser example", () => {
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

  it("signs in, stores a todo, and restores it on reload", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl()}/examples/auth-todo/`, { waitUntil: "networkidle" });

    await page.getByLabel("Email").fill("playwright@example.com");
    await page.getByLabel("Passphrase").fill("correct horse");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("New todo").fill("Verify browser example");
    await page.getByRole("button", { name: "Add todo" }).click();

    expect(await page.getByTestId("session-email").textContent()).toBe("playwright@example.com");
    expect(await page.getByTestId("todo-count").textContent()).toBe("1 open");
    expect(await page.getByTestId("todo-list").textContent()).toContain("Verify browser example");

    await page.reload({ waitUntil: "networkidle" });

    expect(await page.getByTestId("session-email").textContent()).toBe("playwright@example.com");
    expect(await page.getByTestId("todo-list").textContent()).toContain("Verify browser example");
  }, 30000);

  it("keeps the auth and todo views usable on a mobile viewport", async () => {
    if (!page) {
      throw new Error("Missing page.");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl()}/examples/auth-todo/`, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });

    await page.getByLabel("Email").fill("mobile@example.com");
    await page.getByLabel("Passphrase").fill("correct horse");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("New todo").fill("Check small viewport");
    await page.getByRole("button", { name: "Add todo" }).click();

    const shellBox = await page.locator(".shell").boundingBox();
    expect(shellBox?.width).toBeLessThanOrEqual(390);
    expect(await page.getByTestId("todo-list").textContent()).toContain("Check small viewport");
  }, 30000);
});
