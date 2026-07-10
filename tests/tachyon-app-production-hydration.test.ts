import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

let browser: Browser | undefined;
let server: Server | undefined;
let projectDirectory = "";
let outputDirectory = "";
let baseUrl = "";

describe("tachyonApp production hydration", () => {
  beforeAll(async () => {
    projectDirectory = await mkdtemp(path.join(tmpdir(), "tachyon-app-production-hydration-"));
    outputDirectory = path.join(projectDirectory, "dist");
    const sourceRoot = path.join(process.cwd(), "src");
    await writeFile(
      path.join(projectDirectory, "app.ts"),
      `
      import { defineApp } from ${JSON.stringify(path.join(sourceRoot, "app.ts"))};
      export const app = defineApp({
        pages: [{
          path: "/",
          fileName: "index.html",
          template: '<section hydrate:id={id}><button id="increment">Increment</button><span id="count">Count {count}</span><button id="add">Add</button><ul id="rows"><li>A</li></ul></section>',
          scope: { id: "counter", count: 0 },
        }],
      });
    `,
    );
    await writeFile(
      path.join(projectDirectory, "main.ts"),
      `
      import { createHydrationBoundary } from ${JSON.stringify(path.join(sourceRoot, "runtime/hydrate.ts"))};
      const before = document.querySelector("section");
      const result = createHydrationBoundary(document, "counter", (element) => {
        element.querySelector("#increment")?.addEventListener("click", () => {
          const count = element.querySelector("#count");
          if (count) count.textContent = "Count " + String(Number(count.textContent?.replace("Count ", "")) + 1);
        });
        element.querySelector("#add")?.addEventListener("click", () => {
          const row = document.createElement("li");
          row.textContent = "B";
          element.querySelector("#rows")?.append(row);
        });
      });
      if (!result.ok) throw new Error(result.error.message);
      result.value.hydrate();
      Object.assign(window, { __tachyonHydrated: true, __tachyonReusedSsrElement: before === result.value.element() });
    `,
    );
    await writeFile(
      path.join(projectDirectory, "vite.config.ts"),
      `
      import { tachyonApp, tachyonDom } from ${JSON.stringify(path.join(sourceRoot, "vite.ts"))};
      import { app } from "./app";
      export default {
        root: ${JSON.stringify(projectDirectory)},
        build: { outDir: ${JSON.stringify(outputDirectory)}, rollupOptions: { input: "./main.ts" } },
        plugins: [tachyonDom({ reactive: true }), tachyonApp(app, { appScript: "./main.ts" })],
      };
    `,
    );
    await build({
      root: projectDirectory,
      configFile: path.join(projectDirectory, "vite.config.ts"),
      logLevel: "silent",
    });

    server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const relative = pathname === "/" ? "index.html" : pathname.slice(1);
        const filePath = path.resolve(outputDirectory, relative);
        if (!filePath.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) {
          response.writeHead(403).end();
          return;
        }
        const body = await readFile(filePath);
        const contentType = filePath.endsWith(".js") ? "text/javascript" : "text/html";
        response.writeHead(200, { "content-type": contentType }).end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    }
    if (projectDirectory) await rm(projectDirectory, { recursive: true, force: true });
  });

  it("uses the production default and hydrates the existing SSR boundary", async () => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    expect(html).toContain("<!--tachyon-hydrate:counter:start-->");
    expect(html).toContain("<!---->");

    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      expect(await page.evaluate(() => (window as any).__tachyonHydrated)).toBe(true);
      expect(await page.evaluate(() => (window as any).__tachyonReusedSsrElement)).toBe(true);
      await page.locator("#increment").click();
      expect(await page.locator("#count").textContent()).toBe("Count 1");
      await page.locator("#add").click();
      expect(await page.locator("#rows li").allTextContents()).toEqual(["A", "B"]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
