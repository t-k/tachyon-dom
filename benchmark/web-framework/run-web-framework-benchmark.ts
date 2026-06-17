import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { formatWebFrameworkRanking, scoreWebFrameworkMetrics, type WebFrameworkMetric } from "./report";

type CliOptions = {
  smoke: boolean;
  skipBuild: boolean;
  output?: string;
};

type FrameworkConfig = {
  name: string;
  cwd: string;
  build?: readonly string[];
  start: (port: number) => readonly string[];
};

type AutocannonResult = {
  requests: { average?: number; mean?: number };
  latency: { p95?: number; p97_5?: number; p99?: number; average?: number; mean?: number };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const fixtureRoot = path.join(__dirname, "fixtures");

const frameworks: readonly FrameworkConfig[] = [
  {
    name: "tachyon-dom",
    cwd: projectRoot,
    build: ["pnpm", "build"],
    start: (port) => ["node", "benchmark/web-framework/fixtures/tachyon/server.mjs", "--port", String(port)],
  },
  {
    name: "marko-run",
    cwd: path.join(fixtureRoot, "marko-run"),
    build: ["pnpm", "exec", "marko-run", "build"],
    start: (port) => ["pnpm", "exec", "marko-run", "preview", "--host", "127.0.0.1", "--port", String(port)],
  },
  {
    name: "solid-start",
    cwd: path.join(fixtureRoot, "solid-start"),
    build: ["pnpm", "exec", "vinxi", "build"],
    start: (port) => ["pnpm", "exec", "vinxi", "start", "--host", "127.0.0.1", "--port", String(port)],
  },
  {
    name: "tanstack-start",
    cwd: path.join(fixtureRoot, "tanstack-start"),
    build: ["pnpm", "exec", "vite", "build"],
    start: (port) => ["pnpm", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port)],
  },
  {
    name: "next-app-router",
    cwd: projectRoot,
    build: ["pnpm", "exec", "next", "build", "benchmark/web-framework/fixtures/next"],
    start: (port) => [
      "pnpm",
      "exec",
      "next",
      "start",
      "benchmark/web-framework/fixtures/next",
      "-H",
      "127.0.0.1",
      "-p",
      String(port),
    ],
  },
];

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { smoke: false, skipBuild: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--smoke") {
      options.smoke = true;
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--output") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--output requires a value.");
      }
      options.output = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

const runCommand = async (command: readonly string[], cwd: string): Promise<void> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command[0] as string, command.slice(1), { cwd, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command.join(" ")} exited with code ${code ?? "null"}.`));
      }
    });
  });

const freePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Could not allocate a local port."));
        }
      });
    });
    server.on("error", reject);
  });

const waitForServer = async (baseUrl: string, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Server did not become ready at ${baseUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};

const startServer = async (framework: FrameworkConfig, port: number): Promise<ChildProcess> => {
  const command = framework.start(port);
  const logDir = path.join(projectRoot, "benchmark/web-framework/results/logs");
  await mkdir(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, `${framework.name}.log`), { flags: "a" });
  const child = spawn(command[0] as string, command.slice(1), {
    cwd: framework.cwd,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("exit", () => log.end());
  await waitForServer(`http://127.0.0.1:${port}/`, child);
  return child;
};

const stopServer = async (child: ChildProcess): Promise<void> =>
  await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      if (child.exitCode === null) {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }
    }, 5_000).unref();
  });

const runAutocannon = async (url: string, options: CliOptions): Promise<AutocannonResult> => {
  const duration = options.smoke ? "1" : "5";
  const connections = options.smoke ? "5" : "30";
  const command = ["pnpm", "exec", "autocannon", "--json", "-d", duration, "-c", connections, url];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command[0] as string, command.slice(1), {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command.join(" ")} exited with code ${code ?? "null"}: ${stderr}`));
      }
    });
  });
  return JSON.parse(output) as AutocannonResult;
};

const requestsPerSecond = (result: AutocannonResult): number => {
  const value = result.requests.average ?? result.requests.mean;
  if (value === undefined) {
    throw new Error("autocannon result is missing requests.average.");
  }
  return value;
};

const latencyP95 = (result: AutocannonResult): number => {
  const minimumLatencyMs = 0.01;
  const percentile = result.latency.p95 ?? result.latency.p97_5 ?? result.latency.p99;
  if (percentile !== undefined) {
    return Math.max(percentile, minimumLatencyMs);
  }
  const value = result.latency.average ?? result.latency.mean;
  if (value === undefined) {
    throw new Error("autocannon result is missing latency percentiles.");
  }
  return Math.max(value, minimumLatencyMs);
};

const settle = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const validateTextRoute = async (baseUrl: string, routePath: string, markers: readonly string[]): Promise<void> => {
  const response = await fetch(`${baseUrl}${routePath}`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${routePath} returned HTTP ${response.status}.`);
  }
  for (const marker of markers) {
    if (!body.includes(marker)) {
      throw new Error(`${routePath} response did not include ${JSON.stringify(marker)}.`);
    }
  }
};

const validateFrameworkFixture = async (baseUrl: string): Promise<void> => {
  await validateTextRoute(baseUrl, "/", ["data-route", "home", "Static route"]);
  await validateTextRoute(baseUrl, "/products/42", ["data-route", "product", "Product 42"]);
  await validateTextRoute(baseUrl, "/dashboard/users", ["data-route", "users", "Users"]);
  await validateTextRoute(baseUrl, "/dashboard/orders", ["data-route", "orders", "Orders"]);
  await validateTextRoute(baseUrl, "/stream", ["data-route", "stream", "data-stream", "done"]);
};

const measureStreamOnce = async (url: string, agent: http.Agent): Promise<{ ttfb: number; complete: number }> =>
  await new Promise((resolve, reject) => {
    const start = performance.now();
    let ttfb = 0;
    const request = http.get(url, { agent }, (response) => {
      response.once("data", () => {
        ttfb = performance.now() - start;
      });
      response.on("data", () => undefined);
      response.on("end", () =>
        resolve({ ttfb: ttfb || performance.now() - start, complete: performance.now() - start }),
      );
    });
    request.on("error", reject);
    request.setTimeout(10_000, () => {
      request.destroy(new Error(`Timed out while measuring ${url}`));
    });
  });

const measureStream = async (url: string): Promise<{ ttfb: number; complete: number }> => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await measureStreamOnce(url, agent);
    return await measureStreamOnce(url, agent);
  } finally {
    agent.destroy();
  }
};

const measureClientNavigation = async (browser: Browser, baseUrl: string): Promise<number> => {
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/dashboard/users`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-route="users"]');
    const start = performance.now();
    await page.click('[data-nav="orders"]');
    await page.waitForSelector('[data-route="orders"]', { timeout: 750 }).catch(async () => {
      await page.goto(`${baseUrl}/dashboard/orders`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-route="orders"]');
    });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    return performance.now() - start;
  } finally {
    await page.close();
  }
};

const measureFramework = async (
  framework: FrameworkConfig,
  options: CliOptions,
  browser: Browser,
): Promise<WebFrameworkMetric> => {
  if (framework.build && !options.skipBuild) {
    console.log(`Building ${framework.name}...`);
    await runCommand(framework.build, framework.cwd);
  }

  const port = await freePort();
  console.log(`Measuring ${framework.name} on ${port}...`);
  const child = await startServer(framework, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await validateFrameworkFixture(baseUrl);
    const stream = await measureStream(`${baseUrl}/stream`);
    const staticResult = await runAutocannon(`${baseUrl}/`, options);
    const dynamicResult = await runAutocannon(`${baseUrl}/products/42`, options);
    await settle(options.smoke ? 50 : 150);
    const clientNavigationMs = await measureClientNavigation(browser, baseUrl);
    return {
      framework: framework.name,
      staticRequestsPerSecond: requestsPerSecond(staticResult),
      staticLatencyP95Ms: latencyP95(staticResult),
      dynamicRequestsPerSecond: requestsPerSecond(dynamicResult),
      dynamicLatencyP95Ms: latencyP95(dynamicResult),
      streamTtfbMs: stream.ttfb,
      streamCompleteMs: stream.complete,
      clientNavigationMs,
    };
  } finally {
    await stopServer(child);
  }
};

const defaultOutputPath = (): string => {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(projectRoot, "benchmark/web-framework/results", `web-framework-${stamp}.json`);
};

const run = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ headless: true });
  const metrics: WebFrameworkMetric[] = [];
  try {
    for (const framework of frameworks) {
      metrics.push(await measureFramework(framework, options, browser));
    }
  } finally {
    await browser.close();
  }

  const ranking = scoreWebFrameworkMetrics(metrics);
  const table = formatWebFrameworkRanking(ranking);
  const outputPath = path.resolve(projectRoot, options.output ?? defaultOutputPath());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), smoke: options.smoke, metrics, ranking, table }, null, 2)}\n`,
  );
  console.log("");
  console.log(table);
  console.log("");
  console.log(`Wrote JSON results to ${outputPath}`);
};

await run();
