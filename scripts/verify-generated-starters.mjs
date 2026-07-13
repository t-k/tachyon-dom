import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const run = async (command, args, cwd) => {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, CI: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${stdout}${stderr}`, { cause: error });
  }
};

const interactivePage = `<script lang="ts">
export const scope = () => ({
  count: 0,
  id: "counter",
  rows: ["A"],
});
</script>
<section hydrate:id={id}>
  <button id="increment" on:click={increment}>Increment</button>
  <span id="count">Count {count}</span>
  <button id="add" on:click={add}>Add</button>
  <ul id="rows">
    <for each={rows} key={row}>
      <li>{row}</li>
    </for>
  </ul>
</section>
`;

const interactiveClient = `import { bind } from "../routes/index/page.td?client";
import { createSignal } from "tachyon-dom/runtime/signal";

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
});
`;

const contentTypeFor = (file) => (file.endsWith(".js") ? "text/javascript" : "text/html");

const verifyProductionHydration = async (directory) => {
  const outputDirectory = path.join(directory, "dist");
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://starter.local").pathname;
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      const file = path.resolve(outputDirectory, relative);
      const root = path.resolve(outputDirectory);
      if (!file.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": contentTypeFor(file) }).end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing starter verification address.");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "networkidle" });
    if (!(await page.evaluate(() => window.__tachyonHydrated === true))) {
      throw new Error(`${directory} did not hydrate the packaged starter.`);
    }
    if (!(await page.evaluate(() => window.__tachyonReusedSsrElement === true))) {
      throw new Error(`${directory} replaced the packaged starter SSR root.`);
    }
    await page.locator("#increment").click();
    if ((await page.locator("#count").textContent()) !== "Count 1") {
      throw new Error(`${directory} did not update packaged starter text.`);
    }
    await page.locator("#add").click();
    const rows = await page.locator("#rows li").allTextContents();
    if (rows.join(",") !== "A,B") throw new Error(`${directory} did not update the packaged starter keyed list.`);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

const verifyGeneratedProject = async (directory, packageTarball) => {
  await run("pnpm", ["add", `tachyon-dom@file:${packageTarball}`], directory);
  await run("pnpm", ["typecheck"], directory);
  await run("pnpm", ["test"], directory);
  await run("pnpm", ["build"], directory);
  const initialHtml = await readFile(path.join(directory, "dist", "index.html"), "utf8");
  if (!initialHtml.includes("Welcome")) throw new Error(`${directory} did not build the Welcome page.`);

  const appFile = path.join(directory, "src", "app.ts");
  const pageFile = path.join(directory, "src", "routes", "index", "page.td");
  const appBefore = await readFile(appFile, "utf8");
  const pageBefore = await readFile(pageFile, "utf8");
  if (!pageBefore.includes('title: "Welcome"')) throw new Error(`${pageFile} does not contain the starter title.`);
  await writeFile(pageFile, pageBefore.replace('title: "Welcome"', 'title: "Edited"'));
  await run("pnpm", ["typecheck"], directory);
  await run("pnpm", ["build"], directory);
  const appAfter = await readFile(appFile, "utf8");
  const editedHtml = await readFile(path.join(directory, "dist", "index.html"), "utf8");
  if (appAfter !== appBefore) throw new Error(`${appFile} changed while editing the route-local scope.`);
  if (!editedHtml.includes("Edited")) throw new Error(`${directory} did not rebuild the edited route-local scope.`);

  await writeFile(pageFile, interactivePage);
  await writeFile(path.join(directory, "src", "client", "main.ts"), interactiveClient);
  await run("pnpm", ["typecheck"], directory);
  await run("pnpm", ["build"], directory);
  const interactiveHtml = await readFile(path.join(directory, "dist", "index.html"), "utf8");
  if (interactiveHtml.includes('\n  <button id="increment"')) {
    throw new Error(`${directory} did not condense the formatted packaged starter route.`);
  }
  if (!interactiveHtml.includes("tachyon-hydrate:counter:start")) {
    throw new Error(`${directory} did not emit the packaged starter hydration boundary.`);
  }
  await verifyProductionHydration(directory);
};

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "tachyon-dom-starter-verification-"));
try {
  const artifacts = path.join(temporaryRoot, "artifacts");
  const harness = path.join(temporaryRoot, "harness");
  const cliProject = path.join(temporaryRoot, "tachyon-cli-app");
  const createProject = path.join(temporaryRoot, "tachyon-create-app");
  await mkdir(artifacts, { recursive: true });
  await mkdir(harness, { recursive: true });
  await writeFile(path.join(harness, "package.json"), '{"private":true,"type":"module"}\n');

  await run("pnpm", ["build"], projectRoot);
  await run("pnpm", ["exec", "tsc", "-p", "packages/create-tachyon-dom/tsconfig.json"], projectRoot);
  await run("pnpm", ["pack", "--pack-destination", artifacts], projectRoot);
  await run(
    "pnpm",
    ["pack", "--pack-destination", artifacts],
    path.join(projectRoot, "packages", "create-tachyon-dom"),
  );

  const rootPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const createPackage = JSON.parse(
    await readFile(path.join(projectRoot, "packages", "create-tachyon-dom", "package.json"), "utf8"),
  );
  const tachyonTarball = path.join(artifacts, `tachyon-dom-${rootPackage.version}.tgz`);
  const createTarball = path.join(artifacts, `create-tachyon-dom-${createPackage.version}.tgz`);
  await run("pnpm", ["pkg", "set", `pnpm.overrides.create-tachyon-dom>tachyon-dom=file:${tachyonTarball}`], harness);
  await run("pnpm", ["add", tachyonTarball, createTarball], harness);
  await run("pnpm", ["exec", "tachyon-dom", "init", "--out", cliProject, "--template", "basic"], harness);
  await run("pnpm", ["exec", "create-tachyon-dom", createProject, "--template", "basic"], harness);

  await verifyGeneratedProject(cliProject, tachyonTarball);
  await verifyGeneratedProject(createProject, tachyonTarball);
  process.stdout.write("Verified tachyon-dom init and create-tachyon-dom generated projects.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
