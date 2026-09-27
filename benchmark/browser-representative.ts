import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
import { build } from "esbuild";
import { chromium } from "playwright";
import { loadRepresentativeGeneratedModules } from "./generated-template-driver.js";

export type BrowserRepresentativeOptions = {
  iterations: number;
  warmup: number;
  itemCount: number;
  childCount: number;
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
  browserVersion: string;
  paths: Record<
    "keyed-rows" | "text-template" | "mixed-template",
    {
      bundleBrotliBytes: number;
      samples: BrowserRepresentativeSample[];
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
      paths[pathName] = {
        bundleBrotliBytes:
          brotliCompressSync(Buffer.from(driverCode)).byteLength +
          (templateCode ? brotliCompressSync(Buffer.from(templateCode)).byteLength : 0),
        samples,
      };
    }
    return {
      measurementMode: "production-browser",
      sampleContract: "fresh-page-cold-import-first-mount-and-warm-operations",
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
    if (!["--iterations", "--warmup", "--item-count", "--child-count", "--output"].includes(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  const options = {
    iterations: Number(values.get("--iterations") ?? 5),
    warmup: Number(values.get("--warmup") ?? 2),
    itemCount: Number(values.get("--item-count") ?? 1000),
    childCount: Number(values.get("--child-count") ?? 2),
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
