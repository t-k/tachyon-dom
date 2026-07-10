import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

let browser: Browser | undefined;
let server: Server | undefined;
let outputDirectory = "";
let baseUrl = "";

const contentType = (filePath: string): string =>
  filePath.endsWith(".js") ? "text/javascript" : filePath.endsWith(".css") ? "text/css" : "text/html";

describe("safe production HTML condensation", () => {
  beforeAll(async () => {
    outputDirectory = await mkdtemp(path.join(tmpdir(), "tachyon-safe-html-production-"));
    await build({
      build: { emptyOutDir: true, outDir: outputDirectory },
      configFile: path.join(process.cwd(), "examples/full-app/vite.config.ts"),
      logLevel: "silent",
    });
    server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const relative = pathname.endsWith("/") ? `${pathname.slice(1)}index.html` : pathname.slice(1);
        const filePath = path.resolve(outputDirectory, relative || "index.html");
        if (!filePath.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) {
          response.writeHead(403).end();
          return;
        }
        const body = await readFile(filePath);
        response.writeHead(200, { "content-type": contentType(filePath) }).end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing production server address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  });

  it("hydrates condensed output and keeps event, text, and keyed-list updates working", async () => {
    const response = await fetch(`${baseUrl}/counter/`);
    const html = await response.text();
    expect(html).toContain("<!---->");
    expect(html).toContain('<meta charset="UTF-8" />');

    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.goto(`${baseUrl}/counter/`, { waitUntil: "networkidle" });
      await page.getByTestId("increment").click();
      expect(await page.getByTestId("count-value").textContent()).toBe("1");
      expect(await page.getByTestId("projected-value").textContent()).toBe("3");

      await page.getByRole("link", { name: "Lists" }).click();
      await expect.poll(() => page.getByTestId("row").count()).toBe(3);
      await page.getByTestId("add-row").click();
      await expect.poll(() => page.getByTestId("row").count()).toBe(4);
    } finally {
      await page.close();
    }
  }, 30_000);
});
