import { performance } from "node:perf_hooks";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseTachyonSfc,
  sfcScriptTransformCacheLimit,
  transformSfcScript,
  type TachyonSfcScript,
  type TransformSfcScriptOptions,
} from "../../src/compiler/sfc";

// Measures the SFC script transform cache under call orders that resemble a
// real Vite build instead of the same script called back to back. Hits are
// detected through result identity: the cache hands out the same frozen value
// for a key until that key is evicted. The retained size is an estimate that
// mirrors the cache's own LRU bookkeeping (key text plus generated code).

export type CacheCall = {
  script: TachyonSfcScript;
  options?: TransformSfcScriptOptions;
};

export type ScenarioResult = {
  name: string;
  calls: number;
  hits: number;
  hitRate: number;
  totalMs: number;
  microsPerCall: number;
  retainedChars: number;
  retainedEntries: number;
};

export const cacheKeyFor = (call: CacheCall): string => {
  const identifiers = call.options?.templateIdentifiers ? [...call.options.templateIdentifiers].sort() : undefined;
  return JSON.stringify([call.script.attrs, call.script.content, identifiers]);
};

export const scriptFromSource = (source: string): TachyonSfcScript | undefined => {
  const descriptor = parseTachyonSfc(source);
  return descriptor.ok ? descriptor.value.script : undefined;
};

export const exampleSfcSources = (root: string): string[] => {
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry.endsWith(".td")) sources.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return sources.sort();
};

export const syntheticScript = (index: number, statements = 8): TachyonSfcScript => {
  const lines: string[] = [];
  for (let statement = 0; statement < statements; statement++) {
    lines.push(`const value${statement} = ${index * statements + statement};`);
  }
  lines.push(`const label = \`synthetic-${index}\`;`);
  return { attrs: "setup", offset: 0, content: lines.join("\n") };
};

// One SFC is requested for the server target, the client target and every
// hydration chunk in a row. Only the first request pays for the transform.
export const perFileTargetsScenario = (scripts: readonly TachyonSfcScript[], boundaries = 2): CacheCall[] =>
  scripts.flatMap((script) => Array.from({ length: 2 + boundaries }, () => ({ script })));

// Every SFC is processed once for one target, then the whole set again for
// another. Sets larger than the cache limit lose most of the second pass.
export const sweepThenTargetScenario = (scripts: readonly TachyonSfcScript[]): CacheCall[] => [
  ...scripts.map((script) => ({ script })),
  ...scripts.map((script) => ({ script })),
];

// A large script is edited between requests, so every call misses and the
// cost is dominated by key generation and the transform itself.
export const editLargeScriptScenario = (script: TachyonSfcScript, edits: number): CacheCall[] =>
  Array.from({ length: edits }, (_, edit) => ({
    script: { ...script, content: `${script.content}\n// edit ${edit}` },
  }));

// The script text is unchanged but its position inside the SFC moves, which
// must still hit the cache while error offsets are shifted per call.
export const offsetOnlyScenario = (script: TachyonSfcScript, moves: number): CacheCall[] =>
  Array.from({ length: moves }, (_, move) => ({ script: { ...script, offset: move * 3 } }));

export const runScenario = (name: string, calls: readonly CacheCall[]): ScenarioResult => {
  const seen = new Map<string, unknown>();
  const retained = new Map<string, number>();
  let hits = 0;
  const started = performance.now();
  for (const call of calls) {
    const result = transformSfcScript(call.script, call.options);
    const key = cacheKeyFor(call);
    const value = result.ok ? result.value : result.error.message;
    if (seen.get(key) === value) hits++;
    seen.set(key, value);
    retained.delete(key);
    retained.set(key, key.length + (result.ok ? result.value.code.length : 0));
    for (const oldest of retained.keys()) {
      if (retained.size <= sfcScriptTransformCacheLimit) break;
      retained.delete(oldest);
    }
  }
  const totalMs = performance.now() - started;
  let retainedChars = 0;
  for (const chars of retained.values()) retainedChars += chars;
  return {
    name,
    calls: calls.length,
    hits,
    hitRate: calls.length === 0 ? 0 : hits / calls.length,
    totalMs,
    microsPerCall: calls.length === 0 ? 0 : (totalMs * 1_000) / calls.length,
    retainedChars,
    retainedEntries: retained.size,
  };
};

const main = (): void => {
  const exampleScripts = exampleSfcSources(join(import.meta.dirname, "../../examples"))
    .map(scriptFromSource)
    .filter((script): script is TachyonSfcScript => script !== undefined);
  const largeScript = exampleScripts.reduce((largest, script) =>
    script.content.length > largest.content.length ? script : largest,
  );
  const overLimit = Array.from({ length: sfcScriptTransformCacheLimit + 32 }, (_, index) => syntheticScript(index));
  const underLimit = overLimit.slice(0, Math.floor(sfcScriptTransformCacheLimit / 2));
  const results = [
    runScenario("examples: server+client+2 chunks per file", perFileTargetsScenario(exampleScripts)),
    runScenario(`sweep ${underLimit.length} files, then second target`, sweepThenTargetScenario(underLimit)),
    runScenario(`sweep ${overLimit.length} files, then second target`, sweepThenTargetScenario(overLimit)),
    runScenario("edit largest example script 200 times", editLargeScriptScenario(largeScript, 200)),
    runScenario("same script, offset moves 500 times", offsetOnlyScenario(largeScript, 500)),
  ];
  console.log(`Tachyon SFC transform cache benchmark (limit ${sfcScriptTransformCacheLimit} entries)`);
  console.table(
    results.map((result) => ({
      scenario: result.name,
      calls: result.calls,
      "hit rate": `${(result.hitRate * 100).toFixed(1)}%`,
      "us/call": result.microsPerCall.toFixed(1),
      "retained chars": result.retainedChars,
      "retained entries": result.retainedEntries,
    })),
  );
};

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
