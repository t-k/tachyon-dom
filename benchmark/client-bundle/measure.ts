import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { Browser } from "playwright";
import type { ClientBundleFixture } from "./fixtures.js";

export type AssetKind = "script" | "modulepreload" | "stylesheet";

export type HtmlAsset = { href: string; kind: AssetKind };

export type SizeMeasurement = { rawBytes: number; gzipBytes: number; brotliBytes: number };

export type AssetMeasurement = SizeMeasurement & HtmlAsset & { file: string };

export type FixtureMeasurement = {
  name: string;
  description: string;
  initialPath: string;
  /** True when the hydrated page passed the fixture's interaction check in Chromium. */
  validated: boolean;
  html: SizeMeasurement;
  javascript: SizeMeasurement;
  stylesheets: SizeMeasurement;
  /** Everything a cold browser fetches for the initial route: HTML, JavaScript, and stylesheets. */
  initial: SizeMeasurement;
  assets: readonly AssetMeasurement[];
};

const attributeValue = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const isSameOrigin = (href: string): boolean => !/^(?:[a-z]+:)?\/\//i.test(href) && !href.startsWith("data:");

const resolveHref = (href: string, pagePath: string): string =>
  new URL(href, `http://fixture.local${pagePath.endsWith("/") ? pagePath : `${pagePath}/`}`).pathname;

/**
 * List the same-origin assets the initial document references in its `<head>` and `<body>`.
 *
 * Only module scripts, module preloads, and stylesheets count: they are what a cold browser fetches before
 * the page is interactive. Inline scripts are part of the HTML measurement instead.
 */
export const collectHtmlAssets = (html: string, pagePath: string): HtmlAsset[] => {
  const assets: HtmlAsset[] = [];
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const element = (match[1] as string).toLowerCase();
    if (element === "script") {
      const src = attributeValue(tag, "src");
      if (src && attributeValue(tag, "type")?.toLowerCase() === "module" && isSameOrigin(src)) {
        assets.push({ href: resolveHref(src, pagePath), kind: "script" });
      }
      continue;
    }
    const rel = attributeValue(tag, "rel")?.toLowerCase();
    const href = attributeValue(tag, "href");
    if (!href || !isSameOrigin(href)) continue;
    if (rel === "modulepreload") assets.push({ href: resolveHref(href, pagePath), kind: "modulepreload" });
    if (rel === "stylesheet") assets.push({ href: resolveHref(href, pagePath), kind: "stylesheet" });
  }
  return assets;
};

export const measureBytes = (content: Buffer): SizeMeasurement => ({
  rawBytes: content.byteLength,
  gzipBytes: gzipSync(content).byteLength,
  brotliBytes: brotliCompressSync(content).byteLength,
});

const sumSizes = (sizes: readonly SizeMeasurement[]): SizeMeasurement => ({
  rawBytes: sizes.reduce((total, size) => total + size.rawBytes, 0),
  gzipBytes: sizes.reduce((total, size) => total + size.gzipBytes, 0),
  brotliBytes: sizes.reduce((total, size) => total + size.brotliBytes, 0),
});

export const htmlFileForPath = (routePath: string): string => {
  const segments = routePath.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "index.html" : `${segments.join("/")}/index.html`;
};

const distFile = (distDir: string, urlPath: string): string => {
  const file = path.resolve(distDir, `.${urlPath}`);
  if (!file.startsWith(`${path.resolve(distDir)}${path.sep}`)) throw new Error(`Asset ${urlPath} escapes ${distDir}.`);
  return file;
};

const execFileAsync = promisify(execFile);

/**
 * Run the fixture's production Vite build the way the starter does, from the project directory, and return
 * its output directory. The starter's `loadRouteApp` resolves `src/routes` against the working directory,
 * so the build runs as a child process instead of through the Vite API.
 */
export const buildFixtureProject = async (projectDir: string): Promise<string> => {
  const viteBin = path.join(projectDir, "node_modules", "vite", "bin", "vite.js");
  try {
    await execFileAsync(process.execPath, [viteBin, "build", "--logLevel", "error"], {
      cwd: projectDir,
      env: { ...process.env, NODE_ENV: "production" },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    throw new Error(`Vite build failed in ${projectDir}\n${output.stdout ?? ""}${output.stderr ?? ""}`, {
      cause: error,
    });
  }
  return path.join(projectDir, "dist");
};

/** Measure the initial document and every same-origin asset it references. */
export const measureBuiltFixture = async (
  distDir: string,
  initialPath: string,
): Promise<Omit<FixtureMeasurement, "name" | "description" | "validated">> => {
  const htmlBuffer = await readFile(path.join(distDir, htmlFileForPath(initialPath)));
  const html = measureBytes(htmlBuffer);
  const assets: AssetMeasurement[] = [];
  const seen = new Set<string>();
  for (const asset of collectHtmlAssets(htmlBuffer.toString("utf8"), initialPath)) {
    if (seen.has(asset.href)) continue;
    seen.add(asset.href);
    const file = distFile(distDir, asset.href);
    assets.push({ ...asset, file: path.relative(distDir, file), ...measureBytes(await readFile(file)) });
  }
  const javascript = sumSizes(assets.filter((asset) => asset.kind !== "stylesheet"));
  const stylesheets = sumSizes(assets.filter((asset) => asset.kind === "stylesheet"));
  return { initialPath, html, javascript, stylesheets, initial: sumSizes([html, javascript, stylesheets]), assets };
};

const contentTypeFor = (file: string): string => {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/html; charset=utf-8";
};

const serveDist = async (distDir: string): Promise<{ server: Server; baseUrl: string }> => {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://fixture.local").pathname;
      const file = distFile(distDir, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
      response.writeHead(200, { "content-type": contentTypeFor(file) }).end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

/**
 * Load the built page in Chromium, run the fixture's interaction, and fail when hydration did not happen.
 *
 * A bundle that does not hydrate would still have a size, so every recorded number comes from a page that
 * responded to a real click.
 */
export const validateFixtureInteraction = async (
  browser: Browser,
  distDir: string,
  fixture: ClientBundleFixture,
): Promise<void> => {
  const { server, baseUrl } = await serveDist(distDir);
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${baseUrl}${fixture.initialPath}`, { waitUntil: "networkidle" });
    if (pageErrors.length > 0) throw new Error(`${fixture.name} failed to hydrate: ${pageErrors.join("; ")}`);
    await page.click(fixture.validate.click);
    const target = page.locator(fixture.validate.expect.selector);
    await target.waitFor({ timeout: 5_000 });
    const text = ((await target.textContent()) ?? "").trim();
    if (text !== fixture.validate.expect.text) {
      throw new Error(`${fixture.name} expected "${fixture.validate.expect.text}" but found "${text}".`);
    }
    if (pageErrors.length > 0) throw new Error(`${fixture.name} raised errors: ${pageErrors.join("; ")}`);
  } finally {
    await page.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};
