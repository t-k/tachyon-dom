import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeNodeResponse } from "../src/adapters/node.js";

const numberArg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : Number(process.argv[index + 1]);
  return value && Number.isFinite(value) && value > 0 ? value : fallback;
};

const stringArg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return (index < 0 ? undefined : process.argv[index + 1]) ?? fallback;
};

const connections = numberArg("--connections", 6);
const chunksPerConnection = numberArg("--chunks", 128);
const chunkBytes = numberArg("--chunk-bytes", 32 * 1024);
const drainDelayMs = numberArg("--drain-delay-ms", 2);
const label = stringArg("--label", "run");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = stringArg(
  "--output",
  path.resolve("benchmark/streaming-backpressure-results", `${stamp}-${label}.json`),
);

let sourcePullCount = 0;
let queuedBytes = 0;
let peakQueuedBytes = 0;
let peakRssBytes = process.memoryUsage().rss;
const startingRssBytes = peakRssBytes;
const sample = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 1);

const runConnection = async (): Promise<void> => {
  let emitted = 0;
  let drainScheduled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        sourcePullCount += 1;
        if (emitted >= chunksPerConnection) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    },
    { highWaterMark: 0 },
  );
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: false,
    setHeader: () => undefined,
    write: (chunk: Uint8Array) => {
      queuedBytes += chunk.byteLength;
      peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes);
      if (!drainScheduled) {
        drainScheduled = true;
        setTimeout(() => {
          queuedBytes = Math.max(0, queuedBytes - chunkBytes);
          drainScheduled = false;
          response.emit("drain");
        }, drainDelayMs);
      }
      return false;
    },
    end: () => {
      response.writableEnded = true;
    },
  });
  await writeNodeResponse(new Response(body), response as never);
};

const startedAt = performance.now();
await Promise.all(Array.from({ length: connections }, () => runConnection()));
const completionTimeMs = performance.now() - startedAt;
clearInterval(sample);
peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

const result = {
  schemaVersion: 1,
  label,
  controls: { connections, chunksPerConnection, chunkBytes, drainDelayMs },
  metrics: {
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
