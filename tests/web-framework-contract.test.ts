import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  measureStreamDistribution,
  measureStreamSemantics,
  validateDynamicRouteSemantics,
  WEB_FRAMEWORK_CONTRACT_VERSION,
} from "../benchmark/web-framework/contract";

const servers: Array<ReturnType<typeof createServer>> = [];

const serve = async (handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address.");
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("web framework benchmark contract", () => {
  it("versions and retains every repeated stream sample", async () => {
    expect(WEB_FRAMEWORK_CONTRACT_VERSION).toBe(4);
    const valid = await serve((_request, response) => {
      response.write('<main data-stream="shell">Shell');
      setTimeout(() => response.end('<section data-stream="done">Done</section></main>'), 12);
    });
    const measured = await measureStreamDistribution(`${valid}/stream`, { warmups: 1, samples: 3 });
    expect(measured.warmups).toBe(1);
    expect(measured.samples).toHaveLength(3);
    expect(measured.samples.every((sample) => sample.chunkArrivalMs.length >= 2)).toBe(true);
  });

  it("requires two distinct request-time dynamic route responses", async () => {
    const valid = await serve((request, response) => {
      const id = request.url?.split("/").at(-1) ?? "";
      response.end(`<h1>Product ${id}</h1>`);
    });
    await expect(validateDynamicRouteSemantics(valid)).resolves.toHaveLength(4);

    const precomputed = await serve((_request, response) => response.end("<h1>Product 42</h1>"));
    await expect(validateDynamicRouteSemantics(precomputed)).rejects.toThrow("Dynamic product route did not render request id");

    const finiteBodies = new Map([
      ["/products/42", "<h1>Product 42</h1>"],
      ["/products/43", "<h1>Product 43</h1>"],
    ]);
    const finite = await serve((request, response) => {
      const body = finiteBodies.get(request.url ?? "");
      response.statusCode = body === undefined ? 404 : 200;
      response.end(body ?? "Not Found");
    });
    await expect(validateDynamicRouteSemantics(finite)).rejects.toThrow("Dynamic product route did not render request id");
  });

  it("requires a shell and delayed payload with distinct arrival timestamps", async () => {
    const valid = await serve((_request, response) => {
      response.write('<main data-stream="shell">Shell');
      setTimeout(() => response.end('<section data-stream="done">Done</section></main>'), 20);
    });
    const agent = new http.Agent({ keepAlive: true });
    try {
      const measured = await measureStreamSemantics(`${valid}/stream`, agent);
      expect(measured.chunkArrivalMs).toHaveLength(2);
      expect(measured.complete).toBeGreaterThan(measured.ttfb);
    } finally {
      agent.destroy();
    }

    const buffered = await serve((_request, response) => {
      response.end('<main data-stream="shell"><section data-stream="done">Done</section></main>');
    });
    const bufferedAgent = new http.Agent();
    try {
      await expect(measureStreamSemantics(`${buffered}/stream`, bufferedAgent)).rejects.toThrow(
        "at least two downstream chunk",
      );
    } finally {
      bufferedAgent.destroy();
    }
  });

  it("accepts minified unquoted stream marker attributes", async () => {
    const valid = await serve((_request, response) => {
      response.write("<main data-stream=shell>Shell");
      setTimeout(() => response.end("<section data-stream=done>Done</section></main>"), 20);
    });
    const agent = new http.Agent({ keepAlive: true });
    try {
      await expect(measureStreamSemantics(`${valid}/stream`, agent)).resolves.toMatchObject({
        chunkArrivalMs: expect.any(Array),
      });
    } finally {
      agent.destroy();
    }
  });
});
