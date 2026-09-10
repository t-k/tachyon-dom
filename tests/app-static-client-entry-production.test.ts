// 074 C01: a fully static page must not ask the browser for the app's JavaScript, and the pages that do need it
// must keep working. This builds real Vite output and loads it in Chromium, so what is asserted is the request
// list a browser actually makes.
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

const sourceRoot = path.join(process.cwd(), "src");

type Fixture = { outputDirectory: string; baseUrl: string };

let browser: Browser | undefined;
const servers: Server[] = [];
let projectDirectory = "";
let sharedEntry: Fixture;
let pageScopedEntry: Fixture;
let staticOnly: Fixture;

const serve = async (outputDirectory: string): Promise<string> => {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      const filePath = path.resolve(outputDirectory, relative);
      if (!filePath.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": filePath.endsWith(".js") ? "text/javascript" : "text/html" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address.");
  return `http://127.0.0.1:${address.port}`;
};

const buildFixture = async (name: string, plugin: string, appModule: string): Promise<Fixture> => {
  const outputDirectory = path.join(projectDirectory, name);
  await writeFile(
    path.join(projectDirectory, `${name}.config.ts`),
    `
    import { tachyonApp, tachyonDom } from ${JSON.stringify(path.join(sourceRoot, "vite.ts"))};
    import { app } from "./${appModule}";
    export default {
      root: ${JSON.stringify(projectDirectory)},
      build: { outDir: ${JSON.stringify(outputDirectory)}, rollupOptions: { input: "./main.ts" } },
      plugins: [tachyonDom({ reactive: true }), tachyonApp(app, ${plugin})],
    };
  `,
  );
  await build({
    root: projectDirectory,
    configFile: path.join(projectDirectory, `${name}.config.ts`),
    logLevel: "silent",
  });
  return { outputDirectory, baseUrl: await serve(outputDirectory) };
};

const scriptRequests = async (url: string): Promise<string[]> => {
  const page = await browser?.newPage();
  if (!page) throw new Error("Missing browser page.");
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script" || request.url().endsWith(".js")) requested.push(request.url());
  });
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    return requested;
  } finally {
    await page.close();
  }
};

describe("static pages and the client entry in a production build", () => {
  beforeAll(async () => {
    projectDirectory = await mkdtemp(path.join(tmpdir(), "tachyon-static-client-entry-"));
    // A shared module with a side effect of its own, the way an application's client entry usually has one.
    await writeFile(path.join(projectDirectory, "shared.ts"), `document.documentElement.dataset.shared = "ready";\n`);
    await writeFile(
      path.join(projectDirectory, "main.ts"),
      `
      import "./shared";
      import { createHydrationBoundary } from ${JSON.stringify(path.join(sourceRoot, "runtime/hydrate.ts"))};
      const boundary = createHydrationBoundary(document, "panel", (element) => {
        element.querySelector("button")?.addEventListener("click", () => {
          element.setAttribute("data-opened", "yes");
        });
      });
      if (boundary.ok) boundary.value.hydrate();
      `,
    );
    const pages = `[
      { path: "/", fileName: "index.html", template: '<main><h1>Static</h1><p>No client work here.</p></main>' },
      {
        path: "/island",
        fileName: "island.html",
        template: '<main><section hydrate:id={id}><button>Open</button></section></main>',
        scope: { id: "panel" },
      },
    ]`;
    await writeFile(
      path.join(projectDirectory, "app.ts"),
      `import { defineApp } from ${JSON.stringify(path.join(sourceRoot, "app.ts"))};
       export const app = defineApp({ templateWhitespace: "condense", pages: ${pages} });`,
    );
    await writeFile(
      path.join(projectDirectory, "static-app.ts"),
      `import { defineApp } from ${JSON.stringify(path.join(sourceRoot, "app.ts"))};
       export const app = defineApp({
         templateWhitespace: "condense",
         pages: [{ path: "/", fileName: "index.html", template: '<main><h1>Static</h1></main>' }],
       });`,
    );

    browser = await chromium.launch({ headless: true });
    sharedEntry = await buildFixture("shared-entry", `{ appScript: "./main.ts", clientEntry: "when-required" }`, "app");
    pageScopedEntry = await buildFixture(
      "page-scoped-entry",
      `{ appScript: "./main.ts", clientEntry: "when-required", clientEntryScope: "pages" }`,
      "app",
    );
    staticOnly = await buildFixture(
      "static-only",
      `{ appScript: "./main.ts", clientEntry: "when-required", clientEntryScope: "pages" }`,
      "static-app",
    );
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    for (const server of servers) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    if (projectDirectory) await rm(projectDirectory, { recursive: true, force: true });
  });

  // The entry is application code with a side effect of its own, so the static page keeps loading it. Dropping
  // the script here is what the previous behaviour did, and it silently stopped the shared setup from running.
  it("keeps an entry that does work of its own on a page with no client work", async () => {
    const requested = await scriptRequests(sharedEntry.baseUrl);
    expect(requested).not.toHaveLength(0);

    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.goto(sharedEntry.baseUrl, { waitUntil: "networkidle" });
      expect(await page.getAttribute("html", "data-shared")).toBe("ready");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("asks for no JavaScript on a static page once the entry is declared page scoped", async () => {
    expect(await scriptRequests(pageScopedEntry.baseUrl)).toEqual([]);

    const html = await (await fetch(pageScopedEntry.baseUrl)).text();
    expect(html).toContain("<h1>Static</h1>");
    expect(html).not.toContain("<script");
  }, 60_000);

  it("still hydrates the page that does need the entry", async () => {
    const page = await browser?.newPage();
    if (!page) throw new Error("Missing browser page.");
    try {
      await page.goto(`${pageScopedEntry.baseUrl}/island.html`, { waitUntil: "networkidle" });
      await page.locator("button").click();
      expect(await page.getAttribute("section", "data-opened")).toBe("yes");
      expect(await page.getAttribute("html", "data-shared")).toBe("ready");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("ships no JavaScript at all when every page leaves the entry out", async () => {
    const files = await readdir(staticOnly.outputDirectory, { recursive: true, withFileTypes: true });
    const names = files.filter((file) => file.isFile()).map((file) => file.name);

    expect(names.filter((name) => name.endsWith(".js"))).toEqual([]);
    expect(names).toContain("index.html");
  }, 60_000);
});
