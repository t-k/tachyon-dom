import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { collectBenchmarkProvenance, collectDependencyVersions } from "../provenance";
import { attachArtifactManifest } from "../shared/artifact-manifest";
import { clientBundleFixtures, materializeClientBundleFixture, type ClientBundleFixture } from "./fixtures";
import {
  buildFixtureProject,
  measureBuiltFixture,
  validateFixtureInteraction,
  type FixtureMeasurement,
} from "./measure";
import { formatClientBundleDescriptions, formatClientBundleTable } from "./report";

export const CLIENT_BUNDLE_CONTRACT_VERSION = 1;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type ClientBundleCliOptions = {
  output?: string;
  fixtures?: readonly string[];
  skipBrowser: boolean;
};

export const parseClientBundleArgs = (argv: readonly string[]): ClientBundleCliOptions => {
  const options: ClientBundleCliOptions = { skipBrowser: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output requires a path.");
      options.output = value;
      index += 1;
    } else if (argument === "--fixture") {
      const value = argv[index + 1];
      if (!value) throw new Error("--fixture requires a fixture name.");
      options.fixtures = [...(options.fixtures ?? []), value];
      index += 1;
    } else if (argument === "--skip-browser") {
      options.skipBrowser = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
};

const defaultOutputPath = (): string => {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(projectRoot, "benchmark/client-bundle/results", `client-bundle-${stamp}.json`);
};

const selectFixtures = (names: readonly string[] | undefined): readonly ClientBundleFixture[] => {
  if (!names) return clientBundleFixtures;
  return names.map((name) => {
    const fixture = clientBundleFixtures.find((candidate) => candidate.name === name);
    if (!fixture) throw new Error(`Unknown fixture: ${name}`);
    return fixture;
  });
};

const measureFixture = async (
  fixture: ClientBundleFixture,
  workDir: string,
  browser: Browser | undefined,
): Promise<FixtureMeasurement> => {
  const projectDir = await materializeClientBundleFixture(fixture, { workDir, packageRoot: projectRoot });
  const distDir = await buildFixtureProject(projectDir);
  if (browser) await validateFixtureInteraction(browser, distDir, fixture);
  const measured = await measureBuiltFixture(distDir, fixture.initialPath);
  return { name: fixture.name, description: fixture.description, validated: browser !== undefined, ...measured };
};

export const runClientBundleBenchmark = async (options: ClientBundleCliOptions): Promise<string> => {
  const fixtures = selectFixtures(options.fixtures);
  const workDir = await mkdtemp(path.join(tmpdir(), "tachyon-dom-client-bundle-"));
  const browser = options.skipBrowser ? undefined : await chromium.launch({ headless: true });
  const measurements: FixtureMeasurement[] = [];
  try {
    for (const fixture of fixtures) {
      console.log(`Building ${fixture.name}...`);
      measurements.push(await measureFixture(fixture, workDir, browser));
    }
  } finally {
    await browser?.close();
    await rm(workDir, { recursive: true, force: true });
  }

  const table = formatClientBundleTable(measurements);
  const outputPath = path.resolve(projectRoot, options.output ?? defaultOutputPath());
  await mkdir(path.dirname(outputPath), { recursive: true });
  const artifact = attachArtifactManifest(
    {
      schemaVersion: 2,
      benchmark: { name: "client-bundle", contractVersion: CLIENT_BUNDLE_CONTRACT_VERSION },
      provenance: await collectBenchmarkProvenance({
        cwd: projectRoot,
        argv: [process.execPath, ...process.argv.slice(1)],
        dependencies: await collectDependencyVersions(projectRoot, ["vite", "playwright"]),
        ...(browser ? { browser: { name: "chromium", version: browser.version() } } : {}),
      }),
      workload: {
        fixtures: fixtures.map((fixture) => fixture.name),
        build: { tool: "vite", mode: "production", templateWhitespace: "condense", reactive: true },
        compression: { gzip: "node:zlib-default", brotli: "node:brotli-default" },
        validation: browser ? "chromium-interaction" : "none",
      },
      measurements: { fixtures: measurements, tables: { sizes: table } },
    },
    { pid: process.pid, processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString() },
  );
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\n${table}\n\n${formatClientBundleDescriptions(measurements)}\n\nResults written to ${outputPath}`);
  return outputPath;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runClientBundleBenchmark(parseClientBundleArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
