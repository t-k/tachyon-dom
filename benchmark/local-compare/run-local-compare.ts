import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type LaunchOptions, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { err, ok, type Result } from "neverthrow";
import {
  compareSummaries,
  formatComparisonTable,
  summarizeScenario,
  type ImplementationName,
  type ScenarioSummary,
} from "./report";

type CliOptions = {
  iterations: number;
  warmup: number;
  headful: boolean;
  browserChannel?: string;
  output?: string;
};

type Implementation = {
  name: ImplementationName;
  title: string;
  path: string;
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
  },
  {
    name: "tachyon-dom",
    title: "Tachyon DOM",
    path: "/benchmark/js-framework-benchmark/",
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

const parsePositiveInteger = (value: string, name: string): Result<number, string> => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return err(`${name} must be a positive integer.`);
  }
  return ok(parsed);
};

const parseArgs = (argv: readonly string[]): Result<CliOptions, string> => {
  const options: CliOptions = {
    iterations: 7,
    warmup: 2,
    headful: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--iterations") {
      const value = argv[++index];
      if (!value) {
        return err("--iterations requires a value.");
      }
      const parsed = parsePositiveInteger(value, "--iterations");
      if (parsed.isErr()) {
        return err(parsed.error);
      }
      options.iterations = parsed.value;
    } else if (arg === "--warmup") {
      const value = argv[++index];
      if (!value) {
        return err("--warmup requires a value.");
      }
      const parsed = parsePositiveInteger(value, "--warmup");
      if (parsed.isErr()) {
        return err(parsed.error);
      }
      options.warmup = parsed.value;
    } else if (arg === "--headful") {
      options.headful = true;
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
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }

  return ok(options);
};

const startServer = async (): Promise<ViteDevServer> => {
  const requestedPort = Number.parseInt(process.env.PORT ?? "0", 10);
  const server = await createServer({
    root: projectRoot,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: Number.isFinite(requestedPort) ? requestedPort : 0,
      strictPort: requestedPort > 0,
    },
  });
  await server.listen();
  return server;
};

const baseUrlFor = (server: ViteDevServer): string => {
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

const measureImplementation = async (
  browser: Browser,
  baseUrl: string,
  implementation: Implementation,
  options: CliOptions,
): Promise<ScenarioSummary[]> => {
  const page = await browser.newPage();
  await installDeterministicRandom(page);
  const summaries: ScenarioSummary[] = [];
  try {
    for (const scenario of scenarios) {
      const values: number[] = [];
      const totalRuns = options.warmup + options.iterations;
      for (let run = 0; run < totalRuns; run++) {
        const value = await runBrowserScenario(page, `${baseUrl}${implementation.path}`, scenario.id);
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

const defaultOutputPath = (): string => {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(projectRoot, "benchmark/local-compare/results", `local-compare-${stamp}.json`);
};

const writeResults = async (
  options: CliOptions,
  summaries: readonly ScenarioSummary[],
  table: string,
): Promise<string> => {
  const outputPath = path.resolve(projectRoot, options.output ?? defaultOutputPath());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        iterations: options.iterations,
        warmup: options.warmup,
        baseline: "vanillajs-lite-keyed",
        candidate: "tachyon-dom",
        summaries,
        table,
      },
      null,
      2,
    )}\n`,
  );
  return outputPath;
};

const run = async (options: CliOptions): Promise<void> => {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await startServer();
    const baseUrl = baseUrlFor(server);
    browser = await launchBrowser(options);
    const summaries: ScenarioSummary[] = [];

    for (const implementation of implementations) {
      console.log(`Measuring ${implementation.title}...`);
      summaries.push(...(await measureImplementation(browser, baseUrl, implementation, options)));
    }

    const rows = compareSummaries(summaries, "vanillajs-lite-keyed", "tachyon-dom");
    const table = formatComparisonTable(rows);
    const outputPath = await writeResults(options, summaries, table);
    console.log("");
    console.log(table);
    console.log("");
    console.log(`Wrote JSON results to ${outputPath}`);
  } finally {
    await browser?.close();
    await server?.close();
  }
};

const parsed = parseArgs(process.argv.slice(2));
if (parsed.isErr()) {
  console.error(parsed.error);
  process.exitCode = 1;
} else {
  await run(parsed.value);
}
