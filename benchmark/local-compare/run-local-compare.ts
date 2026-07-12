import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import marko from "@marko/vite";
import { chromium, type Browser, type CDPSession, type LaunchOptions, type Page } from "playwright";
import solid from "vite-plugin-solid";
import { build, createServer, preview, type PreviewServer, type ViteDevServer } from "vite";
import { err, ok, type Result } from "../../src/result";
import { collectBenchmarkProvenance, collectDependencyVersions } from "../provenance";
import {
  buildAuxiliaryMetricMatrix,
  buildScenarioMatrix,
  compareSummaries,
  evaluateBenchmarkRegressionGate,
  formatAuxiliaryMetricTable,
  formatGeomeanComparisonTable,
  formatScenarioMatrixTable,
  geomeanComparison,
  summarizeAuxiliaryMetric,
  summarizeScenario,
  type AuxiliaryMetricSummary,
  type ImplementationName,
  type ScenarioSummary,
} from "./report";
import {
  createLocalRunPlan,
  LOCAL_COMPARE_CONTRACT_VERSION,
  LOCAL_COMPARE_ENVELOPE_SCHEMA_VERSION,
  type LocalRunPlan,
} from "./run-plan";

type CliOptions = {
  iterations: number;
  warmup: number;
  headful: boolean;
  serveMode: "dev" | "production";
  browserChannel?: string;
  output?: string;
  maxGeomeanRatio?: number;
  maxMemoryRatio?: number;
  traceImplementation?: ImplementationName;
  traceScenario?: string;
  traceOutput?: string;
  seed: number;
  runIndex: number;
  runId: string;
};

type Implementation = {
  name: ImplementationName;
  title: string;
  path: string;
  sourcePaths: readonly string[];
  entrySourcePaths?: readonly string[];
};

type Scenario = {
  id: string;
  label: string;
};

const implementations: readonly Implementation[] = [
  {
    name: "vanillajs-lite-keyed",
    title: "vanillajs-lite-keyed",
    path: "/benchmark/local-compare/vanillajs-lite/",
    sourcePaths: ["benchmark/local-compare/vanillajs-lite"],
    entrySourcePaths: ["benchmark/local-compare/vanillajs-lite/src/Main.js"],
  },
  {
    name: "vanillajs-3-keyed",
    title: "vanillajs-3-keyed",
    path: "/benchmark/local-compare/vanillajs-3/",
    sourcePaths: ["benchmark/local-compare/vanillajs-3"],
    entrySourcePaths: ["benchmark/local-compare/vanillajs-3/src/Main.js"],
  },
  {
    name: "vanillajs-keyed",
    title: "vanillajs-keyed",
    path: "/benchmark/local-compare/vanillajs/",
    sourcePaths: ["benchmark/local-compare/vanillajs"],
    entrySourcePaths: ["benchmark/local-compare/vanillajs/src/Main.js"],
  },
  {
    name: "solid-keyed",
    title: "solid-keyed",
    path: "/benchmark/local-compare/solid/",
    sourcePaths: ["benchmark/local-compare/solid"],
    entrySourcePaths: ["benchmark/local-compare/solid/src/main.jsx"],
  },
  {
    name: "marko-keyed",
    title: "marko-keyed",
    path: "/benchmark/local-compare/marko/",
    sourcePaths: ["benchmark/local-compare/marko"],
    entrySourcePaths: ["benchmark/local-compare/marko/src/App.marko", "benchmark/local-compare/marko/src/data.js"],
  },
  {
    name: "mreact-keyed",
    title: "mreact-keyed",
    path: "/benchmark/local-compare/mreact/",
    sourcePaths: ["benchmark/local-compare/mreact"],
    entrySourcePaths: ["benchmark/local-compare/mreact/src/main.ts"],
  },
  {
    name: "tachyon-dom",
    title: "Tachyon DOM",
    path: "/benchmark/js-framework-benchmark/",
    sourcePaths: [
      "benchmark/js-framework-benchmark/index.html",
      "benchmark/js-framework-benchmark/src/main.ts",
    ],
    entrySourcePaths: ["benchmark/js-framework-benchmark/src/main.ts"],
  },
];

const scenarios: readonly Scenario[] = [
  { id: "createRows", label: "create rows" },
  { id: "replaceAllRows", label: "replace all rows" },
  { id: "partialUpdate", label: "partial update" },
  { id: "selectRow", label: "select row" },
  { id: "swapRows", label: "swap rows" },
  { id: "removeRow", label: "remove row" },
  { id: "createManyRows", label: "create many rows" },
  { id: "appendRows", label: "append rows" },
  { id: "clearRows", label: "clear rows" },
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const mreactRoot = path.resolve(projectRoot, "../mreact");
const mreactPackageAliases = existsSync(path.join(mreactRoot, "packages")) ? [
  {
    find: /^@reckona\/mreact-reactive-core$/,
    replacement: path.join(mreactRoot, "packages/reactive-core/src/index.ts"),
  },
  {
    find: /^@reckona\/mreact-reactive-core\/(.+)$/,
    replacement: `${path.join(mreactRoot, "packages/reactive-core/src")}/$1.ts`,
  },
  {
    find: /^@reckona\/mreact-reactive-dom$/,
    replacement: path.join(mreactRoot, "packages/reactive-dom/src/index.ts"),
  },
  {
    find: /^@reckona\/mreact-reactive-dom\/(.+)$/,
    replacement: `${path.join(mreactRoot, "packages/reactive-dom/src")}/$1.ts`,
  },
  {
    find: /^@reckona\/mreact-shared$/,
    replacement: path.join(mreactRoot, "packages/shared/src/index.ts"),
  },
  {
    find: /^@reckona\/mreact-shared\/(.+)$/,
    replacement: `${path.join(mreactRoot, "packages/shared/src")}/$1.ts`,
  },
] : [];
const benchmarkPlugins = () => [solid(), marko({ linked: false })];

const parsePositiveInteger = (value: string, name: string): Result<number, string> => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return err(`${name} must be a positive integer.`);
  }
  return ok(parsed);
};

const parsePositiveNumber = (value: string, name: string): Result<number, string> => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return err(`${name} must be a positive number.`);
  }
  return ok(parsed);
};

const parseArgs = (argv: readonly string[]): Result<CliOptions, string> => {
  const options: CliOptions = {
    iterations: 7,
    warmup: 2,
    headful: false,
    // Production (bundled + minified) is the canonical mode: it reflects what
    // applications actually ship. Pass --serve-mode dev for fast local iteration.
    serveMode: "production",
    seed: 1,
    runIndex: 0,
    runId: randomUUID(),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--iterations") {
      const value = argv[++index];
      if (!value) {
        return err("--iterations requires a value.");
      }
      const parsed = parsePositiveInteger(value, "--iterations");
      if (!parsed.ok) {
        return err(parsed.error);
      }
      options.iterations = parsed.value;
    } else if (arg === "--warmup") {
      const value = argv[++index];
      if (!value) {
        return err("--warmup requires a value.");
      }
      const parsed = parsePositiveInteger(value, "--warmup");
      if (!parsed.ok) {
        return err(parsed.error);
      }
      options.warmup = parsed.value;
    } else if (arg === "--seed" || arg === "--run-index") {
      const value = argv[++index];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) return err(`${arg} must be a non-negative integer.`);
      if (arg === "--seed") options.seed = parsed;
      else options.runIndex = parsed;
    } else if (arg === "--run-id") {
      const value = argv[++index];
      if (!value) return err("--run-id requires a value.");
      options.runId = value;
    } else if (arg === "--headful") {
      options.headful = true;
    } else if (arg === "--serve-mode") {
      const value = argv[++index];
      if (value !== "dev" && value !== "production") {
        return err("--serve-mode must be dev or production.");
      }
      options.serveMode = value;
    } else if (arg === "--browser-channel") {
      const value = argv[++index];
      if (!value) {
        return err("--browser-channel requires a value.");
      }
      options.browserChannel = value;
    } else if (arg === "--output") {
      const value = argv[++index];
      if (!value) {
        return err("--output requires a value.");
      }
      options.output = value;
    } else if (arg === "--max-geomean-ratio") {
      const value = argv[++index];
      if (!value) {
        return err("--max-geomean-ratio requires a value.");
      }
      const parsed = parsePositiveNumber(value, "--max-geomean-ratio");
      if (!parsed.ok) {
        return err(parsed.error);
      }
      options.maxGeomeanRatio = parsed.value;
    } else if (arg === "--max-memory-ratio") {
      const value = argv[++index];
      if (!value) {
        return err("--max-memory-ratio requires a value.");
      }
      const parsed = parsePositiveNumber(value, "--max-memory-ratio");
      if (!parsed.ok) {
        return err(parsed.error);
      }
      options.maxMemoryRatio = parsed.value;
    } else if (arg === "--trace-implementation") {
      const value = argv[++index];
      if (!value) {
        return err("--trace-implementation requires a value.");
      }
      options.traceImplementation = value;
    } else if (arg === "--trace-scenario") {
      const value = argv[++index];
      if (!value) {
        return err("--trace-scenario requires a value.");
      }
      options.traceScenario = value;
    } else if (arg === "--trace-output") {
      const value = argv[++index];
      if (!value) {
        return err("--trace-output requires a value.");
      }
      options.traceOutput = value;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }

  if (
    (options.traceImplementation && !options.traceScenario) ||
    (!options.traceImplementation && options.traceScenario)
  ) {
    return err("--trace-implementation and --trace-scenario must be provided together.");
  }

  return ok(options);
};

type BenchmarkServer = ViteDevServer | PreviewServer;

const startDevServer = async (): Promise<ViteDevServer> => {
  const requestedPort = Number.parseInt(process.env.PORT ?? "0", 10);
  const server = await createServer({
    configFile: false,
    root: projectRoot,
    logLevel: "silent",
    plugins: benchmarkPlugins(),
    resolve: {
      alias: mreactPackageAliases,
    },
    server: {
      host: "127.0.0.1",
      port: Number.isFinite(requestedPort) ? requestedPort : 0,
      strictPort: requestedPort > 0,
      fs: {
        allow: [projectRoot, mreactRoot],
      },
    },
  });
  await server.listen();
  return server;
};

const productionOutDir = path.join(projectRoot, ".vite/local-compare-dist");

const benchmarkHtmlInputs = (): Record<string, string> =>
  Object.fromEntries(
    implementations.map((implementation) => [
      implementation.name,
      path.join(projectRoot, implementation.path.replace(/^\//, ""), "index.html"),
    ]),
  );

const startProductionServer = async (): Promise<PreviewServer> => {
  const requestedPort = Number.parseInt(process.env.PORT ?? "0", 10);
  await rm(productionOutDir, { recursive: true, force: true });
  await build({
    configFile: false,
    root: projectRoot,
    logLevel: "silent",
    plugins: benchmarkPlugins(),
    resolve: {
      alias: mreactPackageAliases,
    },
    build: {
      outDir: productionOutDir,
      emptyOutDir: true,
      rollupOptions: {
        input: benchmarkHtmlInputs(),
      },
    },
  });
  await Promise.all([
    cp(
      path.join(projectRoot, "benchmark/local-compare/vanillajs/src"),
      path.join(productionOutDir, "benchmark/local-compare/vanillajs/src"),
      { recursive: true },
    ),
    cp(
      path.join(projectRoot, "benchmark/local-compare/vanillajs-3/src"),
      path.join(productionOutDir, "benchmark/local-compare/vanillajs-3/src"),
      { recursive: true },
    ),
  ]);
  return await preview({
    configFile: false,
    root: projectRoot,
    logLevel: "silent",
    plugins: benchmarkPlugins(),
    resolve: {
      alias: mreactPackageAliases,
    },
    build: {
      outDir: productionOutDir,
    },
    preview: {
      host: "127.0.0.1",
      port: Number.isFinite(requestedPort) ? requestedPort : 0,
      strictPort: requestedPort > 0,
    },
  });
};

const startServer = async (options: CliOptions): Promise<BenchmarkServer> =>
  options.serveMode === "production" ? await startProductionServer() : await startDevServer();

const baseUrlFor = (server: BenchmarkServer): string => {
  const localUrl = server.resolvedUrls?.local.find((url) => url.startsWith("http://127.0.0.1"));
  if (localUrl) {
    return localUrl.replace(/\/$/, "");
  }
  const firstUrl = server.resolvedUrls?.local[0];
  if (firstUrl) {
    return firstUrl.replace(/\/$/, "");
  }
  throw new Error("Could not resolve Vite dev server URL.");
};

const launchBrowser = async (options: CliOptions): Promise<Browser> => {
  try {
    const launchOptions: LaunchOptions = {
      headless: !options.headful,
    };
    if (options.browserChannel) {
      launchOptions.channel = options.browserChannel;
    }
    return await chromium.launch(launchOptions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not launch Playwright Chromium. Run "npx playwright install chromium" and retry. Original error: ${detail}`,
    );
  }
};

const installDeterministicRandom = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    Math.random = (() => {
      let seed = 123456789;
      return () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
    })();
  });
};

const settlePage = async (page: Page): Promise<void> => {
  await page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))`);
};

const clickInPage = async (page: Page, selector: string): Promise<void> => {
  await page.evaluate(`(() => {
    const targetSelector = ${JSON.stringify(selector)};
    const element = document.querySelector(targetSelector);
    if (!element) {
      throw new Error("Missing selector: " + targetSelector);
    }
    if (element instanceof HTMLElement) {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }
  })()`);
  await settlePage(page);
};

const browserScenarioScript = String.raw`
window.__runLocalBenchmarkScenario = async (id) => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const settle = async () => {
    await frame();
    await frame();
  };
  const click = (selector) => {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error("Missing selector: " + selector);
    }
    if (element instanceof HTMLElement) {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }
  };
  const assertForeground = () => {
    const entries = performance.getEntriesByType("visibility-state");
    const firstEntry = entries[0];
    if (document.visibilityState === "hidden" || firstEntry?.name === "hidden") {
      throw new Error("The benchmark page is hidden; foreground the browser or run headless.");
    }
  };
  const actionFor = (action) => {
    const selectors = {
      run: "#run",
      runlots: "#runlots",
      add: "#add",
      update: "#update",
      clear: "#clear",
      swaprows: "#swaprows",
      select: "#tbody tr:nth-child(2) td:nth-child(2) a",
      remove: "#tbody tr:nth-child(2) td:nth-child(3) span",
    };
    const selector = selectors[action];
    if (!selector) {
      throw new Error("Unknown action: " + action);
    }
    return selector;
  };
  const plans = {
    createRows: { setup: ["clear"], measure: "run" },
    replaceAllRows: { setup: ["run"], measure: "run" },
    partialUpdate: { setup: ["run"], measure: "update" },
    selectRow: { setup: ["run"], measure: "select" },
    swapRows: { setup: ["run"], measure: "swaprows" },
    removeRow: { setup: ["run"], measure: "remove" },
    createManyRows: { setup: ["clear"], measure: "runlots" },
    appendRows: { setup: ["run"], measure: "add" },
    clearRows: { setup: ["run"], measure: "clear" },
  };
  const plan = plans[id];
  if (!plan) {
    throw new Error("Unknown scenario: " + id);
  }

  assertForeground();
  for (const action of plan.setup) {
    click(actionFor(action));
    await settle();
  }

  const start = performance.now();
  click(actionFor(plan.measure));
  await settle();
  return performance.now() - start;
};
`;

const runBrowserScenario = async (page: Page, url: string, scenarioId: string): Promise<number> => {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("#run");
  await page.addScriptTag({ content: browserScenarioScript });
  return await page.evaluate(`window.__runLocalBenchmarkScenario(${JSON.stringify(scenarioId)})`);
};

const defaultTracePath = (implementation: ImplementationName, scenarioId: string): string => {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(
    projectRoot,
    "benchmark/local-compare/results",
    `trace-${implementation}-${scenarioId}-${stamp}.json`,
  );
};

const readCdpStream = async (session: CDPSession, stream: string): Promise<string> => {
  let data = "";
  for (;;) {
    const chunk = await session.send("IO.read", { handle: stream });
    data += chunk.data;
    if (chunk.eof) {
      break;
    }
  }
  await session.send("IO.close", { handle: stream });
  return data;
};

const captureChromeTrace = async (
  page: Page,
  runScenario: () => Promise<number>,
  outputPath: string,
): Promise<number> => {
  const session = await page.context().newCDPSession(page);
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await session.send("Tracing.start", {
      categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,v8",
      transferMode: "ReturnAsStream",
    });
    const value = await runScenario();
    const traceComplete = new Promise<string>((resolve, reject) => {
      session.once("Tracing.tracingComplete", (event) => {
        if (!event.stream) {
          reject(new Error("Chrome tracing did not return a stream handle."));
          return;
        }
        resolve(event.stream);
      });
    });
    await session.send("Tracing.end");
    const stream = await traceComplete;
    const trace = await readCdpStream(session, stream);
    await writeFile(outputPath, trace);
    return value;
  } finally {
    await session.detach();
  }
};

const measureImplementation = async (
  browser: Browser,
  baseUrl: string,
  implementation: Implementation,
  measuredScenarios: readonly Scenario[],
  options: CliOptions,
): Promise<ScenarioSummary[]> => {
  const page = await browser.newPage();
  await installDeterministicRandom(page);
  const summaries: ScenarioSummary[] = [];
  try {
    for (const scenario of measuredScenarios) {
      const values: number[] = [];
      const totalRuns = options.warmup + options.iterations;
      for (let run = 0; run < totalRuns; run++) {
        const shouldTrace =
          run === options.warmup &&
          options.traceImplementation === implementation.name &&
          options.traceScenario === scenario.id;
        const runScenario = () => runBrowserScenario(page, `${baseUrl}${implementation.path}`, scenario.id);
        const value = shouldTrace
          ? await captureChromeTrace(
              page,
              runScenario,
              path.resolve(projectRoot, options.traceOutput ?? defaultTracePath(implementation.name, scenario.id)),
            )
          : await runScenario();
        if (run >= options.warmup) {
          values.push(value);
        }
      }
      summaries.push(summarizeScenario(scenario.id, scenario.label, implementation.name, values));
    }
  } finally {
    await page.close();
  }
  return summaries;
};

const jsHeapUsedMb = async (page: Page): Promise<number> => {
  const session = await page.context().newCDPSession(page);
  try {
    const usage = await session.send("Runtime.getHeapUsage");
    return usage.usedSize / 1024 / 1024;
  } finally {
    await session.detach();
  }
};

const domNodeCount = async (page: Page): Promise<number> =>
  await page.evaluate(`document.getElementsByTagName("*").length`);

const navigateAndSettle = async (page: Page, url: string): Promise<number> => {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#run");
  await settlePage(page);
  return await page.evaluate(`performance.now()`);
};

const sourceSizeBytes = async (filePath: string): Promise<number> => {
  const absolutePath = path.resolve(projectRoot, filePath);
  const fileStat = await stat(absolutePath);
  if (fileStat.isFile()) {
    return fileStat.size;
  }
  const entries = await readdir(absolutePath);
  const sizes = await Promise.all(entries.map((entry) => sourceSizeBytes(path.join(filePath, entry))));
  return sizes.reduce((total, size) => total + size, 0);
};

const measureAuxiliaryMetrics = async (
  browser: Browser,
  baseUrl: string,
  implementation: Implementation,
): Promise<AuxiliaryMetricSummary[]> => {
  const page = await browser.newPage();
  await installDeterministicRandom(page);
  try {
    const url = `${baseUrl}${implementation.path}`;
    const startupMs = await navigateAndSettle(page, url);
    const readyHeapMb = await jsHeapUsedMb(page);
    const readyDomNodes = await domNodeCount(page);

    await clickInPage(page, "#run");
    const runHeapMb = await jsHeapUsedMb(page);
    const runDomNodes = await domNodeCount(page);

    await navigateAndSettle(page, url);
    for (let cycle = 0; cycle < 5; cycle++) {
      await clickInPage(page, "#run");
      await clickInPage(page, "#clear");
    }
    const runClearHeapMb = await jsHeapUsedMb(page);
    const runClearDomNodes = await domNodeCount(page);
    const sourceBytes = (
      await Promise.all(implementation.sourcePaths.map((sourcePath) => sourceSizeBytes(sourcePath)))
    ).reduce((total, size) => total + size, 0);
    const entrySourceBytes = (
      await Promise.all(
        (implementation.entrySourcePaths ?? implementation.sourcePaths).map((sourcePath) =>
          sourceSizeBytes(sourcePath),
        ),
      )
    ).reduce((total, size) => total + size, 0);

    return [
      summarizeAuxiliaryMetric("startup", "startup load + 2 frames", "ms", implementation.name, startupMs),
      summarizeAuxiliaryMetric("readyHeap", "ready JS heap", "mb", implementation.name, readyHeapMb),
      summarizeAuxiliaryMetric("runHeap", "1k rows JS heap", "mb", implementation.name, runHeapMb),
      summarizeAuxiliaryMetric("runClearHeap", "run/clear 5x JS heap", "mb", implementation.name, runClearHeapMb),
      summarizeAuxiliaryMetric("readyDomNodes", "ready DOM nodes", "count", implementation.name, readyDomNodes),
      summarizeAuxiliaryMetric("runDomNodes", "1k rows DOM nodes", "count", implementation.name, runDomNodes),
      summarizeAuxiliaryMetric(
        "runClearDomNodes",
        "run/clear 5x DOM nodes",
        "count",
        implementation.name,
        runClearDomNodes,
      ),
      summarizeAuxiliaryMetric("localSourceSize", "local source size", "kib", implementation.name, sourceBytes / 1024),
      summarizeAuxiliaryMetric(
        "entrySourceSize",
        "benchmark entry source size",
        "kib",
        implementation.name,
        entrySourceBytes / 1024,
      ),
    ];
  } finally {
    await page.close();
  }
};

const defaultOutputPath = (): string => {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(projectRoot, "benchmark/local-compare/results", `local-compare-${stamp}.json`);
};

const writeResults = async (
  options: CliOptions,
  browserVersion: string,
  summaries: readonly ScenarioSummary[],
  auxiliaryMetrics: readonly AuxiliaryMetricSummary[],
  operationTable: string,
  auxiliaryTable: string,
  directComparisonTable: string,
  plan: LocalRunPlan,
): Promise<string> => {
  const outputPath = path.resolve(projectRoot, options.output ?? defaultOutputPath());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: LOCAL_COMPARE_ENVELOPE_SCHEMA_VERSION,
        benchmark: { name: "local-compare", contractVersion: LOCAL_COMPARE_CONTRACT_VERSION },
        provenance: await collectBenchmarkProvenance({
          cwd: projectRoot,
          argv: [process.execPath, ...process.argv.slice(1)],
          dependencies: await collectDependencyVersions(projectRoot, ["playwright", "vite", "marko", "solid-js"]),
          browser: { name: "chromium", version: browserVersion },
        }),
        workload: {
        runId: plan.runId,
        seed: plan.seed,
        runIndex: plan.runIndex,
        order: plan.implementationOrder,
        scenarioOrder: plan.scenarioOrder,
        iterations: options.iterations,
        warmup: options.warmup,
        serveMode: options.serveMode,
        operationStatistic: "trimmedMean",
        trimFraction: 0.2,
        baseline: "vanillajs-lite-keyed",
        candidate: "tachyon-dom",
        implementations: implementations.map((implementation) => implementation.name),
        },
        measurements: {
        summaries,
        auxiliaryMetrics,
        tables: {
          operations: operationTable,
          auxiliary: auxiliaryTable,
          directComparisons: directComparisonTable,
        },
        },
      },
      null,
      2,
    )}\n`,
  );
  return outputPath;
};

const run = async (options: CliOptions): Promise<void> => {
  let server: BenchmarkServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await startServer(options);
    const baseUrl = baseUrlFor(server);
    browser = await launchBrowser(options);
    const summaries: ScenarioSummary[] = [];
    const auxiliaryMetrics: AuxiliaryMetricSummary[] = [];
    const plan = createLocalRunPlan(
      implementations.map((implementation) => implementation.name),
      scenarios.map((scenario) => scenario.id),
      { runId: options.runId, runIndex: options.runIndex, seed: options.seed },
    );
    const measuredImplementations = plan.implementationOrder.map(
      (name) => implementations.find((implementation) => implementation.name === name) as Implementation,
    );
    const measuredScenarios = plan.scenarioOrder.map(
      (id) => scenarios.find((scenario) => scenario.id === id) as Scenario,
    );

    for (const implementation of measuredImplementations) {
      console.log(`Measuring ${implementation.title}...`);
      summaries.push(...(await measureImplementation(browser, baseUrl, implementation, measuredScenarios, options)));
      auxiliaryMetrics.push(...(await measureAuxiliaryMetrics(browser, baseUrl, implementation)));
    }

    const implementationNames = implementations.map((implementation) => implementation.name);
    const matrixRows = buildScenarioMatrix(summaries, implementationNames, "tachyon-dom");
    const operationTable = formatScenarioMatrixTable(matrixRows, implementationNames, "tachyon-dom");
    const auxiliaryRows = buildAuxiliaryMetricMatrix(auxiliaryMetrics, implementationNames, "tachyon-dom");
    const auxiliaryTable = formatAuxiliaryMetricTable(auxiliaryRows, implementationNames, "tachyon-dom");
    const baselineRows = compareSummaries(summaries, "vanillajs-lite-keyed", "tachyon-dom");
    const directComparisons = ["vanillajs-lite-keyed", "solid-keyed", "marko-keyed"].map((baseline) =>
      geomeanComparison(compareSummaries(summaries, baseline, "tachyon-dom")),
    );
    const directComparisonTable = formatGeomeanComparisonTable(directComparisons);
    const outputPath = await writeResults(
      options,
      browser.version(),
      summaries,
      auxiliaryMetrics,
      operationTable,
      auxiliaryTable,
      directComparisonTable,
      plan,
    );
    console.log("");
    console.log(operationTable);
    console.log("");
    console.log(auxiliaryTable);
    console.log("");
    console.log(directComparisonTable);
    console.log("");
    const trimmedGeomeanRatio =
      baselineRows.reduce((total, row) => total + Math.log(row.trimmedRatio), 0) / Math.max(baselineRows.length, 1);
    console.log(
      `Tachyon DOM trimmed geomean ratio vs vanillajs-lite-keyed: ${Math.exp(trimmedGeomeanRatio).toFixed(3)}x`,
    );
    const gate = evaluateBenchmarkRegressionGate(baselineRows, auxiliaryRows, {
      ...(options.maxGeomeanRatio === undefined ? {} : { maxGeomeanRatio: options.maxGeomeanRatio }),
      ...(options.maxMemoryRatio === undefined ? {} : { maxMemoryRatio: options.maxMemoryRatio }),
    });
    if (options.maxGeomeanRatio !== undefined || options.maxMemoryRatio !== undefined) {
      console.log(`Benchmark regression gate: ${gate.ok ? "passed" : "failed"}`);
      for (const failure of gate.failures) {
        console.error(`Benchmark regression: ${failure}`);
      }
      if (!gate.ok) {
        process.exitCode = 1;
      }
    }
    console.log("");
    console.log(`Wrote JSON results to ${outputPath}`);
  } finally {
    await browser?.close();
    await server?.close();
  }
};

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  process.exitCode = 1;
} else {
  await run(parsed.value);
}
