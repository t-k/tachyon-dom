import { createServer, get, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectBenchmarkProvenance, collectDependencyVersions } from "./provenance.js";

const numberArg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : Number(process.argv[index + 1]);
  return value && Number.isFinite(value) && value > 0 ? value : fallback;
};

const stringArg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return (index < 0 ? undefined : process.argv[index + 1]) ?? fallback;
};

const projectRoot = path.resolve(import.meta.dirname, "..");
const connections = numberArg("--connections", 6);
const chunksPerConnection = numberArg("--chunks", 128);
const chunkBytes = numberArg("--chunk-bytes", 32 * 1024);
const drainDelayMs = numberArg("--drain-delay-ms", 2);
const label = stringArg("--label", "run");
const subjectRoot = path.resolve(stringArg("--subject-root", projectRoot));
const adapterModule = path.resolve(stringArg("--adapter-module", path.join(subjectRoot, "src/adapters/node.ts")));
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = stringArg(
  "--output",
  path.resolve("benchmark/streaming-backpressure-results", `${stamp}-${label}.json`),
);
const { writeNodeResponse } = await import(pathToFileURL(adapterModule).href) as {
  writeNodeResponse: (response: Response, destination: ServerResponse) => Promise<void>;
};

let sourcePullCount = 0;
let peakQueuedBytes = 0;
let peakRssBytes = process.memoryUsage().rss;
const startingRssBytes = peakRssBytes;
const activeResponses = new Set<ServerResponse>();

const server = createServer((request, response) => {
  if (request.url !== "/stream") {
    response.statusCode = 404;
    response.end("Not Found");
    return;
  }
  activeResponses.add(response);
  response.once("close", () => activeResponses.delete(response));
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sourcePullCount += 1;
      if (emitted >= chunksPerConnection) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  }, { highWaterMark: 0 });
  void writeNodeResponse(new Response(body), response).catch((error) => response.destroy(error));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Backpressure benchmark server has no TCP address.");

const sample = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const queuedBytes = [...activeResponses].reduce((total, response) => total + response.writableLength, 0);
  peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes);
}, 1);

const runConnection = async (): Promise<void> =>
  await new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${address.port}/stream`, (response) => {
      response.on("data", () => {
        response.pause();
        setTimeout(() => response.resume(), drainDelayMs);
      });
      response.on("end", resolve);
      response.on("error", reject);
    });
    request.on("error", reject);
  });

const startedAt = performance.now();
try {
  await Promise.all(Array.from({ length: connections }, () => runConnection()));
} finally {
  clearInterval(sample);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
const completionTimeMs = performance.now() - startedAt;
peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

const argv = [process.execPath, ...process.argv.slice(1)];
const provenance = await collectBenchmarkProvenance({
  cwd: projectRoot,
  argv,
  dependencies: await collectDependencyVersions(projectRoot, ["tsx"]),
});
const subject = await collectBenchmarkProvenance({ cwd: subjectRoot, argv });
const result = {
  schemaVersion: 2,
  benchmark: { name: "streaming-backpressure", contractVersion: 2 },
  provenance,
  workload: {
    label,
    transport: "tcp",
    connections,
    chunksPerConnection,
    chunkBytes,
    drainDelayMs,
    adapterModule,
    subject: { root: subjectRoot, git: subject.git },
  },
  measurements: {
    completionTimeMs,
    peakQueuedBytes,
    sourcePullCount,
    startingRssBytes,
    peakRssBytes,
    peakRssDeltaBytes: Math.max(0, peakRssBytes - startingRssBytes),
  },
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output, ...result }));
