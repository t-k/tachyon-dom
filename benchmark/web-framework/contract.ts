import http from "node:http";
import { randomUUID } from "node:crypto";

export const WEB_FRAMEWORK_CONTRACT_VERSION = 5;

export type StreamTiming = {
  ttfb: number;
  complete: number;
  chunkArrivalMs: readonly number[];
};

export type StreamDistribution = {
  warmups: number;
  samples: readonly StreamTiming[];
};

const hasStreamMarker = (html: string, value: "shell" | "done"): boolean =>
  new RegExp(`\\bdata-stream\\s*=\\s*(?:"${value}"|'${value}'|${value}(?=[\\s>]))`).test(html);

export const createDynamicChallengeIds = (count = 4): readonly string[] =>
  Array.from({ length: count }, () => randomUUID().replaceAll("-", ""));

export const validateDynamicRouteSemantics = async (
  baseUrl: string,
  challengeIds: readonly string[] = createDynamicChallengeIds(),
): Promise<readonly string[]> => {
  if (challengeIds.length < 3 || new Set(challengeIds).size !== challengeIds.length) {
    throw new Error("Dynamic route validation requires at least three distinct run-scoped challenge ids.");
  }
  const bodies = await Promise.all(
    challengeIds.map(async (id) => {
      const response = await fetch(`${baseUrl}/products/${id}`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      if (!response.ok || !body.includes(`Product ${id}`)) {
        throw new Error(`Dynamic product route did not render request id ${id} with HTTP 200.`);
      }
      return body;
    }),
  );
  if (new Set(bodies).size !== bodies.length) {
    throw new Error("Dynamic product responses for run-scoped challenge ids were not distinct.");
  }
  return challengeIds;
};

export const measureStreamSemantics = async (
  url: string,
  agent: http.Agent,
  minimumChunkGapMs = 10,
): Promise<StreamTiming> =>
  await new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const chunkArrivalMs: number[] = [];
    const chunks: Buffer[] = [];
    const request = http.get(url, { agent }, (response) => {
      response.on("data", (chunk: Buffer) => {
        chunkArrivalMs.push(performance.now() - startedAt);
        chunks.push(chunk);
      });
      response.on("end", () => {
        const complete = performance.now() - startedAt;
        const textChunks = chunks.map((chunk) => chunk.toString("utf8"));
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Stream route returned HTTP ${response.statusCode ?? "unknown"}.`));
          return;
        }
        if (chunkArrivalMs.length < 2) {
          reject(new Error("Stream route did not produce at least two downstream chunk arrival timestamps."));
          return;
        }
        const shellChunkIndex = textChunks.findIndex((chunk) => hasStreamMarker(chunk, "shell"));
        const doneChunkIndex = textChunks.findIndex((chunk) => hasStreamMarker(chunk, "done"));
        if (shellChunkIndex < 0 || doneChunkIndex <= shellChunkIndex) {
          reject(new Error("The stream shell must arrive in an earlier downstream chunk than the deferred payload."));
          return;
        }
        if (!hasStreamMarker(body, "done")) {
          reject(new Error("Stream route did not produce the deferred payload marker."));
          return;
        }
        const gap = (chunkArrivalMs[doneChunkIndex] ?? 0) - (chunkArrivalMs[shellChunkIndex] ?? 0);
        if (gap < minimumChunkGapMs) {
          reject(new Error(`Stream chunks arrived only ${gap.toFixed(2)}ms apart; expected at least ${minimumChunkGapMs}ms.`));
          return;
        }
        resolve({ ttfb: chunkArrivalMs[0] ?? complete, complete, chunkArrivalMs });
      });
    });
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error(`Timed out while measuring ${url}`)));
  });

export const measureStreamDistribution = async (
  url: string,
  options: { warmups: number; samples: number; minimumChunkGapMs?: number },
): Promise<StreamDistribution> => {
  if (!Number.isInteger(options.warmups) || options.warmups < 0) throw new Error("warmups must be a non-negative integer");
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error("samples must be a positive integer");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    for (let index = 0; index < options.warmups; index += 1) {
      await measureStreamSemantics(url, agent, options.minimumChunkGapMs);
    }
    const samples: StreamTiming[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      samples.push(await measureStreamSemantics(url, agent, options.minimumChunkGapMs));
    }
    return { warmups: options.warmups, samples };
  } finally {
    agent.destroy();
  }
};
