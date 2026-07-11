import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { minifyHtml } from "../src/app.js";
import { collectBenchmarkProvenance, collectDependencyVersions } from "./provenance.js";

const fixtures = {
  document: `<!doctype html>\n<html>\n  <head><meta   charset="UTF-8"   /></head>\n  <body><main><h1>Account</h1></main></body>\n</html>\n`,
  hydration: `<!doctype html><html><body><!--tachyon-hydrate:x:start--><p>Hello <!---->Ada<!---->!</p><!--tachyon-hydrate:x:end--></body></html>`,
  rawText: `<!doctype html><html><body><textarea>  keep\n this  </textarea><script type="application/json">{ "space": "a  b" }</script><style>.x { content: "a  b"; }</style></body></html>`,
} as const;

const legacyMinifyHtml = (html: string): string =>
  `${html
    .replace(/<!--(?!\[if\b)[\s\S]*?-->/gi, "")
    .replace(/\s+</g, "<")
    .replace(/>\s+/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim()}\n`;

const size = (value: string) => ({
  rawBytes: Buffer.byteLength(value),
  gzipBytes: gzipSync(value).byteLength,
  brotliBytes: brotliCompressSync(value).byteLength,
});

const measure = (transform: (html: string) => string, iterations: number) => {
  const outputs = Object.fromEntries(Object.entries(fixtures).map(([name, source]) => [name, transform(source)]));
  for (let index = 0; index < 100; index += 1) {
    for (const source of Object.values(fixtures)) transform(source);
  }
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    for (const source of Object.values(fixtures)) transform(source);
  }
  return {
    durationMs: performance.now() - startedAt,
    outputSizes: Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, size(output)])),
  };
};

const measurePreservedStream = async () => {
  const chunks = ["<main>Loading", "<section>Ready</section></main>"];
  const startedAt = performance.now();
  let firstChunkAt = 0;
  let peakRssBytes = process.memoryUsage().rss;
  const received: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    received.push(chunk);
    if (index === 0) firstChunkAt = performance.now();
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  return {
    firstChunkMs: firstChunkAt - startedAt,
    completionMs: performance.now() - startedAt,
    peakRssBytes,
    chunks: received.length,
    bytes: Buffer.byteLength(received.join("")),
  };
};

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const main = async () => {
  const iterations = Number.parseInt(argument("--iterations") ?? "5000", 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("--iterations must be a positive integer.");
  }
  const output = path.resolve(argument("--output") ?? "benchmark/html-minification-results/latest.json");
  const provenance = await collectBenchmarkProvenance({
    cwd: process.cwd(),
    argv: [process.execPath, ...process.argv.slice(1)],
    dependencies: await collectDependencyVersions(process.cwd(), ["parse5"]),
  });
  const result = {
    schemaVersion: 2,
    benchmark: { name: "html-minification", contractVersion: 1 },
    provenance,
    workload: {
      algorithms: { baseline: "legacyMinifyHtml", candidate: "minifyHtml" },
      buildMode: "production",
      iterations,
      fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, source]) => [name, size(source)])),
      streaming: { chunks: 2, delayMs: 10, policy: "preserve-for-all-streaming-modes" },
    },
    measurements: {
      baseline: measure(legacyMinifyHtml, iterations),
      candidate: measure(minifyHtml, iterations),
      streamingPreserve: await measurePreservedStream(),
      streamingCondenseRequested: await measurePreservedStream(),
    },
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(output);
};

await main();
