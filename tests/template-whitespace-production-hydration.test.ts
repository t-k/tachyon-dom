import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, type Rollup } from "vite";

import { tachyonDom } from "../src/vite";

let browser: Browser | undefined;
let directory = "";
let clientCode = "";
let serverHtml = "";

const outputChunk = (result: Awaited<ReturnType<typeof build>>): Rollup.OutputChunk => {
  const buildOutputs = (Array.isArray(result) ? result : [result]) as Array<{
    output: Array<Rollup.OutputAsset | Rollup.OutputChunk>;
  }>;
  const outputs = buildOutputs.flatMap((entry) => entry.output);
  const chunk = outputs.find((entry): entry is Rollup.OutputChunk => entry.type === "chunk" && entry.isEntry);
  if (!chunk) throw new Error("Missing Vite entry chunk.");
  return chunk;
};

describe("condensed template production hydration", () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tachyon-condensed-hydration-"));
    const sourceRoot = path.join(process.cwd(), "src");
    await writeFile(
      path.join(directory, "page.td"),
      `<section hydrate:id={id}>
        <button id="increment" on:click={increment}>Increment</button>
        <span id="count">Count {count}</span>
        <button id="add" on:click={add}>Add</button>
        <ul id="rows">
          <for each={rows} key={row}>
            <li>{row}</li>
          </for>
        </ul>
      </section>`,
    );
    await writeFile(
      path.join(directory, "server.ts"),
      `import { render } from "./page.td?server";
export const html = render({ id: "counter", count: 0, rows: ["A"] });`,
    );
    await writeFile(
      path.join(directory, "client.ts"),
      `import { bind } from "./page.td?client";
import { createSignal } from ${JSON.stringify(path.join(sourceRoot, "runtime/signal.ts"))};
const element = document.querySelector("section");
if (!(element instanceof HTMLElement)) throw new Error("Missing SSR root.");
const before = element;
const count = createSignal(0);
const rows = createSignal(["A"]);
const cleanup = bind(element, {
  id: "counter",
  count,
  rows,
  increment: () => count.update((value) => value + 1),
  add: () => rows.update((values) => [...values, "B"]),
});
Object.assign(window, {
  __tachyonCleanup: cleanup,
  __tachyonHydrated: true,
  __tachyonReusedSsrElement: before === document.querySelector("section"),
});`,
    );

    const pluginOptions = { reactive: true, templateWhitespace: "condense" as const };
    const resolve = { alias: { "tachyon-dom": sourceRoot } };
    const serverBuild = await build({
      root: directory,
      configFile: false,
      logLevel: "silent",
      resolve,
      plugins: [tachyonDom(pluginOptions)],
      build: {
        write: false,
        ssr: path.join(directory, "server.ts"),
        rollupOptions: { output: { format: "es" } },
      },
    });
    const serverModule = (await import(
      `data:text/javascript;base64,${Buffer.from(outputChunk(serverBuild).code).toString("base64")}`
    )) as {
      html: string;
    };
    serverHtml = serverModule.html;

    const clientBuild = await build({
      root: directory,
      configFile: false,
      logLevel: "silent",
      resolve,
      plugins: [tachyonDom(pluginOptions)],
      build: {
        write: false,
        lib: { entry: path.join(directory, "client.ts"), formats: ["iife"], name: "TachyonHydrationTest" },
      },
    });
    clientCode = outputChunk(clientBuild).code;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("uses identical condensed structure for SSR and client binding", async () => {
    expect(serverHtml).not.toContain("\n");
    expect(serverHtml).toContain("<!--tachyon-hydrate:counter:start-->");

    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.setContent(serverHtml);
      await page.addScriptTag({ content: clientCode });
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
