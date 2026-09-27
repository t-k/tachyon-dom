import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
import { build, version as esbuildVersion } from "esbuild";
import { chromium } from "playwright";
import { loadRepresentativeGeneratedModules } from "./generated-template-driver.js";

export type BrowserRepresentativeOptions = {
  iterations: number;
  warmup: number;
  itemCount: number;
  childCount: number;
  memoryDiagnostics?: boolean;
  memoryCycles?: number;
};

type BrowserNodeCounts = { elements: number; text: number; comments: number };

export type BrowserMemoryDiagnostic = {
  contract: "gc-after-import-mount-dispose-outside-timing";
  baselineHeapBytes: number;
  mountedHeapBytes: number;
  disposedHeapBytes: number;
  repeatedDisposedHeapBytes: number;
  cycles: number;
  checkpoints: Array<{ cycle: number; heapBytes: number }>;
  mountedBytesPerRow: number;
  baselineNodes: BrowserNodeCounts;
  mountedNodes: BrowserNodeCounts;
  disposedNodes: BrowserNodeCounts;
  repeatedDisposedNodes: BrowserNodeCounts;
};

export type BrowserOperation = {
  syncUpdateMs: number;
  settledUpdateMs: number;
  rowCount: number;
  preservedRowIdentities: number;
  preservedChildIdentities: number;
};

export type BrowserRepresentativeSample = {
  coldImportMs: number;
  create: BrowserOperation;
  append: BrowserOperation;
  partialUpdate: BrowserOperation;
  noChange: BrowserOperation;
  sparseOnePercent: BrowserOperation;
  sparseTenPercent: BrowserOperation;
  fullValueUpdate: BrowserOperation;
  mutableOnePercent: BrowserOperation;
  swap: BrowserOperation;
  remove: BrowserOperation;
  childReorder: BrowserOperation;
  childEmpty: BrowserOperation;
  dispose: BrowserOperation;
  interaction?: {
    inputValue: string;
    modelLabel: string;
    clickCount: number;
    handlerRunsAfterDispose: number;
  };
};

export type BrowserRepresentativeResult = {
  measurementMode: "production-browser";
  sampleContract: "fresh-page-cold-import-first-mount-and-warm-operations";
  controls: BrowserRepresentativeOptions;
  provenance: {
    commit: string;
    dirty: boolean;
    node: string;
    platform: string;
    architecture: string;
    cpuModel: string;
    esbuild: string;
  };
  browserVersion: string;
  paths: Record<
    "keyed-rows" | "text-template" | "mixed-template",
    {
      bundleBrotliBytes: number;
      bundleSha256: string;
      samples: BrowserRepresentativeSample[];
      memory?: BrowserMemoryDiagnostic;
    }
  >;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pathNames = ["keyed-rows", "text-template", "mixed-template"] as const;

export const runBrowserRepresentativeBenchmark = async (
  options: BrowserRepresentativeOptions,
): Promise<BrowserRepresentativeResult> => {
  if (!Number.isInteger(options.iterations) || options.iterations < 1) throw new Error("iterations must be positive.");
  if (!Number.isInteger(options.warmup) || options.warmup < 0) throw new Error("warmup must be nonnegative.");
  if (!Number.isInteger(options.itemCount) || options.itemCount < 4) throw new Error("itemCount must be at least 4.");
  if (!Number.isInteger(options.childCount) || options.childCount < 0)
    throw new Error("childCount must be nonnegative.");
  if (options.memoryCycles !== undefined && (!Number.isInteger(options.memoryCycles) || options.memoryCycles < 1)) {
    throw new Error("memoryCycles must be positive.");
  }
  const generated = await loadRepresentativeGeneratedModules();
  const buildDriver = async (entryPoint: string): Promise<string> => {
    const output = await build({
      entryPoints: [path.join(projectRoot, entryPoint)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      define: { __TACHYON_PRODUCTION__: "true" },
    });
    const code = output.outputFiles[0]?.text;
    if (!code) throw new Error(`Representative driver build produced no JavaScript for ${entryPoint}.`);
    return code;
  };
  const [keyedDriverCode, generatedDriverCode] = await Promise.all([
    buildDriver("benchmark/representative-drivers.ts"),
    buildDriver("benchmark/generated-representative-driver.ts"),
  ]);
  const pageBuild = await build({
    entryPoints: [path.join(projectRoot, "benchmark/browser-representative-page.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__tachyonBrowserRepresentativePage",
    platform: "browser",
    target: "es2022",
    minify: true,
  });
  const pageCode = pageBuild.outputFiles[0]?.text;
  if (!pageCode) throw new Error("Representative page harness build produced no JavaScript.");
  const templateBundles = {
    textCode: generated["text-template"].productionBundledCode,
    mixedCode: generated["mixed-template"].productionBundledCode,
  };
  const browser = await chromium.launch({ headless: true });
  const paths = {} as BrowserRepresentativeResult["paths"];
  try {
    for (const pathName of pathNames) {
      const bundles = {
        ...templateBundles,
        driverCode: pathName === "keyed-rows" ? keyedDriverCode : generatedDriverCode,
      };
      const samples: BrowserRepresentativeSample[] = [];
      for (let run = 0; run < options.warmup + options.iterations; run++) {
        const page = await browser.newPage();
        try {
          await page.setContent("<table><tbody></tbody></table>");
          await page.addScriptTag({ content: pageCode });
          const runSample = new Function(
            "arg",
            "return globalThis.__tachyonBrowserRepresentativePage.runSample(arg)",
          ) as (arg: {
            pathName: typeof pathName;
            itemCount: number;
            childCount: number;
            bundles: typeof bundles;
          }) => Promise<BrowserRepresentativeSample>;
          const sample = await page.evaluate(runSample, {
            pathName,
            itemCount: options.itemCount,
            childCount: options.childCount,
            bundles,
          });
          if (run >= options.warmup) samples.push(sample);
        } finally {
          await page.close();
        }
      }
      const driverCode = bundles.driverCode;
      const templateCode = pathName === "keyed-rows" ? "" : generated[pathName].productionBundledCode;
      let memory: BrowserMemoryDiagnostic | undefined;
      if (options.memoryDiagnostics) {
        const page = await browser.newPage();
        const session = await page.context().newCDPSession(page);
        try {
          await page.setContent("<table><tbody></tbody></table>");
          await page.addScriptTag({ content: pageCode });
          const invoke = <T>(name: string, arg?: unknown): Promise<T> =>
            page.evaluate(
              new Function("arg", `return globalThis.__tachyonBrowserRepresentativePage.${name}(arg)`) as (
                arg: unknown,
              ) => Promise<T> | T,
              arg,
            );
          const heapBytes = async (): Promise<number> => {
            await session.send("HeapProfiler.collectGarbage");
            const usage = await session.send("Runtime.getHeapUsage");
            return usage.usedSize as number;
          };
          const baselineNodes = await invoke<BrowserNodeCounts>("prepareMemorySample", {
            pathName,
            itemCount: options.itemCount,
            childCount: options.childCount,
            bundles,
          });
          const baselineHeapBytes = await heapBytes();
          const mountedNodes = await invoke<BrowserNodeCounts>("mountMemorySample");
          const mountedHeapBytes = await heapBytes();
          const disposedNodes = await invoke<BrowserNodeCounts>("disposeMemorySample");
          const disposedHeapBytes = await heapBytes();
          const cycles = options.memoryCycles ?? 1;
          const checkpoints = [{ cycle: 1, heapBytes: disposedHeapBytes }];
          let repeatedDisposedNodes = disposedNodes;
          let repeatedDisposedHeapBytes = disposedHeapBytes;
          let completed = 1;
          for (const target of [...new Set([Math.max(2, Math.floor(cycles / 2)), cycles])].filter(
            (cycle) => cycle > 1 && cycle <= cycles,
          )) {
            repeatedDisposedNodes = await invoke<BrowserNodeCounts>("repeatMemoryCycles", target - completed);
            repeatedDisposedHeapBytes = await heapBytes();
            checkpoints.push({ cycle: target, heapBytes: repeatedDisposedHeapBytes });
            completed = target;
          }
          await invoke<void>("releaseMemorySample");
          memory = {
            contract: "gc-after-import-mount-dispose-outside-timing",
            baselineHeapBytes,
            mountedHeapBytes,
            disposedHeapBytes,
            repeatedDisposedHeapBytes,
            cycles,
            checkpoints,
            mountedBytesPerRow: (mountedHeapBytes - baselineHeapBytes) / options.itemCount,
            baselineNodes,
            mountedNodes,
            disposedNodes,
            repeatedDisposedNodes,
          };
        } finally {
          await session.detach();
          await page.close();
        }
      }
      paths[pathName] = {
        bundleBrotliBytes:
          brotliCompressSync(Buffer.from(driverCode)).byteLength +
          (templateCode ? brotliCompressSync(Buffer.from(templateCode)).byteLength : 0),
        bundleSha256: createHash("sha256").update(driverCode).update(templateCode).digest("hex"),
        samples,
        ...(memory ? { memory } : {}),
      };
    }
    return {
      measurementMode: "production-browser",
      sampleContract: "fresh-page-cold-import-first-mount-and-warm-operations",
      controls: options,
      provenance: {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" }).trim().length > 0,
        node: process.version,
        platform: os.platform(),
        architecture: os.arch(),
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        esbuild: esbuildVersion,
      },
      browserVersion: browser.version(),
      paths,
    };
  } finally {
    await browser.close();
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = new Map<string, string>();
  const firstArgument = process.argv[2] === "--" ? 3 : 2;
  for (let index = firstArgument; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key ?? ""}`);
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (
      ![
        "--iterations",
        "--warmup",
        "--item-count",
        "--child-count",
        "--memory",
        "--memory-cycles",
        "--output",
      ].includes(key)
    ) {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  const options = {
    iterations: Number(values.get("--iterations") ?? 5),
    warmup: Number(values.get("--warmup") ?? 2),
    itemCount: Number(values.get("--item-count") ?? 1000),
    childCount: Number(values.get("--child-count") ?? 2),
    memoryDiagnostics: values.get("--memory") === "true",
    memoryCycles: Number(values.get("--memory-cycles") ?? 1),
  };
  const result = await runBrowserRepresentativeBenchmark(options);
  const output = values.get("--output");
  if (output) {
    const target = path.resolve(output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${target}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
