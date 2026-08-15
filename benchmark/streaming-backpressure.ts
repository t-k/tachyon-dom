import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { collectBenchmarkProvenance, collectDependencyVersions } from "./provenance.js";
import { prepareStreamingBenchmarkAdapter, writeVerifiedBenchmarkArtifact } from "./streaming-subject.js";

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
const registeredPort = Number(process.env.PORT ?? 0);
const label = stringArg("--label", "run");
const subjectRoot = path.resolve(stringArg("--subject-root", projectRoot));
const adapterModule = path.resolve(stringArg("--adapter-module", path.join(subjectRoot, "src/adapters/node.ts")));
const adapterIdentity = await prepareStreamingBenchmarkAdapter(subjectRoot, adapterModule);
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = stringArg(
  "--output",
  path.resolve("benchmark/streaming-backpressure-results", `${stamp}-${label}.json`),
);
try {
  const subject = await collectBenchmarkProvenance({
    cwd: adapterIdentity.subjectRoot,
    argv: [process.execPath, ...process.argv.slice(1)],
  });
  if (subject.git.available !== true || subject.git.commit !== adapterIdentity.commit || subject.git.dirty !== false) {
    throw new Error("Benchmark subject provenance changed after the adapter snapshot was pinned.");
  }
  const { createNodeHandler } = await adapterIdentity.importAdapter<{
    createNodeHandler: (
      options: Record<string, unknown>,
    ) => (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  }>();

  let sourcePullCount = 0;
  let peakQueuedBytes = 0;
  let peakRssBytes = process.memoryUsage().rss;
  const startingRssBytes = peakRssBytes;
  const activeResponses = new Set<ServerResponse>();

  const payload = "x".repeat(chunkBytes);
  const routeHandler = createNodeHandler({
    streaming: true,
    routes: [
      {
        path: "/",
        head: () => ({ title: "Backpressure" }),
        render: ({ outlet }: { outlet: string }) => `<main>${outlet}</main>`,
        children: [
          {
            id: "stream",
            path: "stream",
            loader: () => ({ ready: true }),
            render: () => "",
            stream: () => ({
              [Symbol.asyncIterator]: () => {
                let emitted = 0;
                return {
                  next: async () => {
                    sourcePullCount += 1;
                    if (emitted >= chunksPerConnection) return { done: true as const, value: undefined };
                    emitted += 1;
                    return { done: false as const, value: payload };
                  },
                };
              },
            }),
          },
        ],
      },
    ],
  });

  const server = createServer((request, response) => {
    activeResponses.add(response);
    response.once("close", () => activeResponses.delete(response));
    void routeHandler(request, response).catch((error) => response.destroy(error));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number.isInteger(registeredPort) && registeredPort > 0 ? registeredPort : 0, "127.0.0.1", resolve);
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  const completionTimeMs = performance.now() - startedAt;
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  adapterIdentity.releaseExecutionBoundary();
  await adapterIdentity.verify();

  const argv = [process.execPath, ...process.argv.slice(1)];
  const provenance = await collectBenchmarkProvenance({
    cwd: projectRoot,
    argv,
    dependencies: await collectDependencyVersions(projectRoot, ["tsx", "esbuild"]),
  });
  const result = {
    schemaVersion: 2,
    benchmark: { name: "streaming-backpressure", contractVersion: 4 },
    provenance,
    workload: {
      label,
      transport: "tcp",
      connections,
      chunksPerConnection,
      chunkBytes,
      drainDelayMs,
      routeDocumentComposition: true,
      adapterModule: adapterIdentity.adapterModule,
      adapter: {
        relativePath: adapterIdentity.relativePath,
        sha256: adapterIdentity.sha256,
        gitBlob: adapterIdentity.gitBlob,
        executionBundle: adapterIdentity.executionBundle,
        dependencySnapshot: adapterIdentity.dependencySnapshot,
      },
      subject: { root: adapterIdentity.subjectRoot, git: subject.git },
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
  await writeVerifiedBenchmarkArtifact(adapterIdentity, output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...result }));
} finally {
  await adapterIdentity.cleanup();
}
