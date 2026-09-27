import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRatios, type RatioAnalysis } from "./shared/statistical-authority.js";
import type {
  BrowserOperation,
  BrowserRepresentativeResult,
  BrowserRepresentativeSample,
} from "./browser-representative.js";

export type BrowserRepresentativePair = {
  base: BrowserRepresentativeResult;
  head: BrowserRepresentativeResult;
};

type OperationName = Exclude<keyof BrowserRepresentativeSample, "coldImportMs" | "interaction">;
type PathName = keyof BrowserRepresentativeResult["paths"];
type Metric = RatioAnalysis & { processRatios: number[] };
type OperationMetrics = { sync: Metric; settled: Metric };

export type BrowserRepresentativeComparison = {
  pairCount: number;
  baseCommit: string;
  headCommit: string;
  paths: Record<
    PathName,
    {
      bundleBrotliBytes: { base: number; head: number };
      coldImport: Metric;
      operations: Record<OperationName, OperationMetrics>;
    }
  >;
};

const pathNames = ["keyed-rows", "text-template", "mixed-template"] as const;
const operationNames = [
  "create",
  "append",
  "partialUpdate",
  "noChange",
  "sparseOnePercent",
  "sparseTenPercent",
  "fullValueUpdate",
  "mutableOnePercent",
  "swap",
  "remove",
  "childReorder",
  "childEmpty",
  "dispose",
] as const;

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const validateRun = (run: BrowserRepresentativeResult): void => {
  if (
    run.measurementMode !== "production-browser" ||
    run.sampleContract !== "fresh-page-cold-import-first-mount-and-warm-operations"
  ) {
    throw new Error("Incompatible browser representative contract.");
  }
  if (!run.runId || !/^[a-f0-9]{40}$/.test(run.provenance.commit)) throw new Error("Missing run identity.");
  if (!Number.isInteger(run.controls.iterations) || run.controls.iterations < 1) throw new Error("Invalid iterations.");
  for (const pathName of pathNames) {
    const path = run.paths[pathName];
    if (!path || path.samples.length !== run.controls.iterations) throw new Error(`Invalid ${pathName} samples.`);
    if (!Number.isFinite(path.bundleBrotliBytes) || path.bundleBrotliBytes <= 0)
      throw new Error(`Invalid ${pathName} size.`);
    for (const sample of path.samples) {
      const values = [
        sample.coldImportMs,
        ...operationNames.flatMap((name) => [sample[name].syncUpdateMs, sample[name].settledUpdateMs]),
      ];
      if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error(`Invalid ${pathName} timing.`);
    }
  }
};

const environmentFor = (run: BrowserRepresentativeResult) => ({
  controls: run.controls,
  browserVersion: run.browserVersion,
  node: run.provenance.node,
  platform: run.provenance.platform,
  architecture: run.provenance.architecture,
  cpuModel: run.provenance.cpuModel,
  esbuild: run.provenance.esbuild,
});

export const compareBrowserRepresentativeRuns = (
  pairs: readonly BrowserRepresentativePair[],
  options: { allowDirty?: boolean } = {},
): BrowserRepresentativeComparison => {
  if (pairs.length === 0) throw new Error("At least one base/head pair is required.");
  const reference = pairs[0] as BrowserRepresentativePair;
  const baseCommit = reference.base.provenance.commit;
  const headCommit = reference.head.provenance.commit;
  if (baseCommit === headCommit) throw new Error("Base and head commits must differ.");
  const environment = environmentFor(reference.base);
  const seenRuns = new Set<string>();
  for (const pair of pairs) {
    for (const [kind, run] of [
      ["base", pair.base],
      ["head", pair.head],
    ] as const) {
      validateRun(run);
      if (seenRuns.has(run.runId)) throw new Error(`duplicate runId ${run.runId}`);
      seenRuns.add(run.runId);
      if (run.provenance.dirty && !options.allowDirty) throw new Error(`${kind} is dirty.`);
      if (run.provenance.commit !== (kind === "base" ? baseCommit : headCommit))
        throw new Error(`${kind} commit changed.`);
      const currentEnvironment = environmentFor(run);
      for (const key of Object.keys(environment) as Array<keyof typeof environment>) {
        if (!same(currentEnvironment[key], environment[key])) throw new Error(`${key} differs between runs.`);
      }
    }
  }
  const metric = (read: (run: BrowserRepresentativeResult) => number): Metric => {
    const processRatios = pairs.map(({ base, head }) => {
      const baseline = read(base);
      const candidate = read(head);
      if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(candidate) || candidate <= 0) {
        throw new Error("A process metric is not finite and positive.");
      }
      return candidate / baseline;
    });
    return { ...analyzeRatios(processRatios, { seed: 27, resamples: 10_000 }), processRatios };
  };
  const paths = {} as BrowserRepresentativeComparison["paths"];
  for (const pathName of pathNames) {
    const firstBase = reference.base.paths[pathName];
    const firstHead = reference.head.paths[pathName];
    for (const { base, head } of pairs) {
      if (
        base.paths[pathName].bundleSha256 !== firstBase.bundleSha256 ||
        base.paths[pathName].bundleBrotliBytes !== firstBase.bundleBrotliBytes
      ) {
        throw new Error(`${pathName} base bundle changed across processes.`);
      }
      if (
        head.paths[pathName].bundleSha256 !== firstHead.bundleSha256 ||
        head.paths[pathName].bundleBrotliBytes !== firstHead.bundleBrotliBytes
      ) {
        throw new Error(`${pathName} head bundle changed across processes.`);
      }
    }
    const operations = {} as Record<OperationName, OperationMetrics>;
    for (const operation of operationNames) {
      const read =
        (field: keyof BrowserOperation) =>
        (run: BrowserRepresentativeResult): number =>
          mean(run.paths[pathName].samples.map((sample) => sample[operation][field]));
      operations[operation] = {
        sync: metric(read("syncUpdateMs")),
        settled: metric(read("settledUpdateMs")),
      };
    }
    paths[pathName] = {
      bundleBrotliBytes: { base: firstBase.bundleBrotliBytes, head: firstHead.bundleBrotliBytes },
      coldImport: metric((run) => mean(run.paths[pathName].samples.map((sample) => sample.coldImportMs))),
      operations,
    };
  }
  return { pairCount: pairs.length, baseCommit, headCommit, paths };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filePairs: Array<{ base: string; head: string }> = [];
  let output: string | undefined;
  let allowDirty = false;
  for (let index = process.argv[2] === "--" ? 3 : 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === "--pair") {
      const base = process.argv[++index];
      const head = process.argv[++index];
      if (!base || !head) throw new Error("--pair requires base and head result files.");
      filePairs.push({ base, head });
    } else if (argument === "--output") {
      output = process.argv[++index];
      if (!output) throw new Error("--output requires a path.");
    } else if (argument === "--allow-dirty-smoke") {
      allowDirty = true;
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }
  const pairs = await Promise.all(
    filePairs.map(async ({ base, head }) => ({
      base: JSON.parse(await readFile(base, "utf8")) as BrowserRepresentativeResult,
      head: JSON.parse(await readFile(head, "utf8")) as BrowserRepresentativeResult,
    })),
  );
  const report = compareBrowserRepresentativeRuns(pairs, { allowDirty });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, json);
  else process.stdout.write(json);
}
