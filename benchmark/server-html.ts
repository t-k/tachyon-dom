import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { html } from "../src/server/html";

const corpus = Array.from({ length: 1_000 }, (_, index) => `asset-${index}-A&B`);
const corpusHash = createHash("sha256").update(corpus.join("\n")).digest("hex");
const iterations = 200;
const warmupIterations = 20;

const renderCorpus = (): void => {
  for (const value of corpus) {
    String(html`<img src=${value} alt="benchmark" />`);
  }
};

for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
  renderCorpus();
}

const started = performance.now();
for (let iteration = 0; iteration < iterations; iteration += 1) {
  renderCorpus();
}
const durationMs = performance.now() - started;

console.log(
  JSON.stringify({
    node: process.version,
    corpusHash,
    corpusSize: corpus.length,
    iterations,
    warmupIterations,
    durationMs,
    operationsPerSecond: (corpus.length * iterations * 1_000) / durationMs,
  }),
);
