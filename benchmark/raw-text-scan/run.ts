import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import { scanRawText, type RawTextScanResult, type RawTextScanState } from "../../src/html-raw-text.js";
import { collectBenchmarkProvenance, collectDependencyVersions } from "../provenance.js";
import { median } from "../shared/statistical-authority.js";
import { scanRawTextWithNativeSearch } from "./candidate.js";
import { evaluateRawTextScanEligibility } from "./evaluation.js";

type ScannerName = "baseline" | "candidate";
type Density = "inert" | "dense-decoy";
type Scanner = typeof scanRawText;

type Workload = {
  id: string;
  input: string;
  state: RawTextScanState;
  codeUnits: number;
  utf8Bytes: number;
  density: Density;
  iterations: number;
};

type Options = {
  samples: number;
  warmups: number;
  fixedIterations: number | null;
  maxCodeUnits: number;
  output: string;
};

type Sample = {
  baselineMs: number;
  candidateMs: number;
  ratio: number;
};

const defaultLengths = [16, 256, 4 * 1024, 64 * 1024, 1024 * 1024];
const states: RawTextScanState[] = [
  { tagName: "style", scriptState: "data" },
  { tagName: "script", scriptState: "data" },
  { tagName: "script", scriptState: "escaped" },
  { tagName: "script", scriptState: "double-escaped" },
];
const densities: Density[] = ["inert", "dense-decoy"];
const scanners: Record<ScannerName, Scanner> = {
  baseline: scanRawText,
  candidate: scanRawTextWithNativeSearch,
};

let checksum = 0;

const defaultOutput = (): string => {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  return resolve(`benchmark/raw-text-scan/results/${timestamp}-node-${process.version}.json`);
};

const parseInteger = (flag: string, value: string | undefined, allowZero: boolean): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
};

const parseOptions = (args: readonly string[]): Options => {
  const options: Options = {
    samples: 9,
    warmups: 2,
    fixedIterations: null,
    maxCodeUnits: 1024 * 1024,
    output: defaultOutput(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") continue;
    const value = args[index + 1];
    if (flag === "--samples") options.samples = parseInteger(flag, value, false);
    else if (flag === "--warmups") options.warmups = parseInteger(flag, value, true);
    else if (flag === "--iterations") options.fixedIterations = parseInteger(flag, value, false);
    else if (flag === "--max-code-units") options.maxCodeUnits = parseInteger(flag, value, false);
    else if (flag === "--output") {
      if (!value) throw new Error("--output requires a path.");
      options.output = resolve(value);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
    index += 1;
  }
  return options;
};

const inputFor = (length: number, density: Density): string => {
  const unit = density === "inert" ? "x" : "<x";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
};

const iterationCount = (codeUnits: number, fixedIterations: number | null): number =>
  fixedIterations ?? Math.max(1, Math.min(100_000, Math.floor((4 * 1024 * 1024) / codeUnits)));

const createWorkloads = (options: Options): Workload[] =>
  defaultLengths
    .filter((codeUnits) => codeUnits <= options.maxCodeUnits)
    .flatMap((codeUnits) =>
      densities.flatMap((density) =>
        states.map((state) => {
          const input = inputFor(codeUnits, density);
          return {
            id: `${state.tagName}-${state.scriptState}-${density}-${codeUnits}`,
            input,
            state,
            codeUnits,
            utf8Bytes: Buffer.byteLength(input),
            density,
            iterations: iterationCount(codeUnits, options.fixedIterations),
          };
        }),
      ),
    );

const resultValue = (result: RawTextScanResult): number => {
  const stateValue = result.state.scriptState === "data" ? 1 : result.state.scriptState === "escaped" ? 2 : 3;
  return result.closingTagStart + 2 + stateValue;
};

const runScanner = (scanner: Scanner, workload: Workload): number => {
  let localChecksum = 0;
  const start = performance.now();
  for (let iteration = 0; iteration < workload.iterations; iteration += 1) {
    localChecksum += resultValue(scanner(workload.input, 0, workload.state));
  }
  const duration = performance.now() - start;
  checksum += localChecksum;
  return duration;
};

const assertEquivalent = (workload: Workload): void => {
  const baseline = scanRawText(workload.input, 0, workload.state);
  const candidate = scanRawTextWithNativeSearch(workload.input, 0, workload.state);
  if (!isDeepStrictEqual(baseline, candidate)) {
    throw new Error(`Candidate mismatch for workload ${workload.id}.`);
  }
};

const measureWorkload = (workload: Workload, workloadIndex: number, options: Options): Sample[] => {
  assertEquivalent(workload);
  for (let warmup = 0; warmup < options.warmups; warmup += 1) {
    const order: ScannerName[] =
      (workloadIndex + warmup) % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const scannerName of order) runScanner(scanners[scannerName], workload);
  }

  return Array.from({ length: options.samples }, (_, sampleIndex) => {
    const order: ScannerName[] =
      (workloadIndex + sampleIndex) % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const durations: Partial<Record<ScannerName, number>> = {};
    for (const scannerName of order) durations[scannerName] = runScanner(scanners[scannerName], workload);
    const baselineMs = durations.baseline as number;
    const candidateMs = durations.candidate as number;
    return { baselineMs, candidateMs, ratio: candidateMs / baselineMs };
  });
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const workloads = createWorkloads(options);
  if (workloads.length === 0) throw new Error("No default workload fits --max-code-units.");

  const measuredWorkloads = workloads.map((workload, workloadIndex) => {
    const samples = measureWorkload(workload, workloadIndex, options);
    return {
      id: workload.id,
      state: workload.state,
      codeUnits: workload.codeUnits,
      utf8Bytes: workload.utf8Bytes,
      density: workload.density,
      iterations: workload.iterations,
      samples,
      medianRatio: median(samples.map(({ ratio }) => ratio)),
    };
  });

  const evaluation = evaluateRawTextScanEligibility(measuredWorkloads, options);
  const provenance = await collectBenchmarkProvenance({
    cwd: process.cwd(),
    argv: [process.execPath, ...process.argv.slice(1)],
    dependencies: await collectDependencyVersions(process.cwd(), ["tsx"]),
  });
  const result = {
    schemaVersion: 2,
    benchmark: { name: "raw-text-scan", contractVersion: 1 },
    provenance,
    workload: {
      samples: options.samples,
      warmups: options.warmups,
      fixedIterations: options.fixedIterations,
      maxCodeUnits: options.maxCodeUnits,
      lengths: defaultLengths.filter((length) => length <= options.maxCodeUnits),
      states,
      densities,
    },
    measurements: { workloads: measuredWorkloads, evaluation, checksum },
  };

  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(options.output);
  console.log(JSON.stringify(evaluation));
};

await main();
