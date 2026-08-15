import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLambdaFetchHandler,
  createLambdaHandler,
  createLambdaStreamingHandler,
  lambdaResponseFromWebResponse,
  requestFromLambdaEvent,
  writeWebResponseToLambdaStream,
} from "../src/adapters/lambda";
import { createNodeFetchHandler, createNodeHandler, writeNodeResponse } from "../src/adapters/node";
import { createWorkersFetchHandler, createWorkersHandler, workersStreamFromChunks } from "../src/adapters/workers";
import { createSecurityHeaders, json, redirect, type RouteDefinition } from "../src/router";

const lambdaEvent = (overrides: Record<string, unknown> = {}) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: "/",
  rawQueryString: "",
  headers: { host: "lambda.example" },
  requestContext: {
    domainName: "lambda.example",
    http: {
      method: "GET",
      path: "/",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "vitest",
    },
  },
  isBase64Encoded: false,
  ...overrides,
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("server adapters", () => {
  it("emits structured request lifecycle events for Workers routes", async () => {
    const events: Array<Record<string, unknown>> = [];
    const handler = createWorkersHandler({
      routes: [{ id: "user-detail", path: "/users/:id", render: ({ params }) => `<h1>${params.id}</h1>` }],
      observability: {
        onRequestStart: (event) => {
          events.push({ type: event.type, method: event.method, path: event.path });
        },
        onRouteMatched: (event) => {
          events.push({
            type: event.type,
            routeId: event.routeId,
            routePattern: event.routePattern,
            path: event.path,
          });
        },
        onResponse: (event) => {
          events.push({
            type: event.type,
            status: event.status,
            routeId: event.routeId,
            routePattern: event.routePattern,
            failedBeforeRouteDispatch: event.failedBeforeRouteDispatch,
            durationIsNumber: typeof event.durationMs === "number",
          });
        },
      },
    });

    const response = await handler.fetch(new Request("https://example.com/users/42"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>42</h1>");
    expect(events).toEqual([
      { type: "request_start", method: "GET", path: "/users/42" },
      { type: "route_matched", routeId: "user-detail", routePattern: "/users/:id", path: "/users/42" },
      {
        type: "response",
        status: 200,
        routeId: "user-detail",
        routePattern: "/users/:id",
        failedBeforeRouteDispatch: false,
        durationIsNumber: true,
      },
    ]);
  });

  it("emits response events for Workers fetch handlers without route definitions", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const handler = createWorkersFetchHandler({
      fetch: () => new Response("ok", { status: 202 }),
      observability: {
        onResponse: (event) => {
          responses.push({
            type: event.type,
            status: event.status,
            path: event.path,
            routeId: event.routeId,
            failedBeforeRouteDispatch: event.failedBeforeRouteDispatch,
          });
        },
      },
    });

    const response = await handler.fetch(new Request("https://example.com/jobs"));

    expect(response.status).toBe(202);
    expect(responses).toEqual([
      {
        type: "response",
        status: 202,
        path: "/jobs",
        routeId: undefined,
        failedBeforeRouteDispatch: false,
      },
    ]);
  });

  it("marks unmatched Workers requests as failed before route dispatch", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const handler = createWorkersHandler({
      routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
      observability: {
        onResponse: (event) => {
          responses.push({
            status: event.status,
            routeId: event.routeId,
            failedBeforeRouteDispatch: event.failedBeforeRouteDispatch,
          });
        },
      },
    });

    const response = await handler.fetch(new Request("https://example.com/missing"));

    expect(response.status).toBe(404);
    expect(responses).toEqual([{ status: 404, routeId: undefined, failedBeforeRouteDispatch: true }]);
  });

  it("labels Node handler observability events with the Node adapter", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const routes: RouteDefinition[] = [{ id: "node-home", path: "/", render: () => "<h1>Node</h1>" }];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeHandler({
      routes,
      observability: {
        onResponse: (event) => {
          responses.push({
            adapter: event.adapter,
            status: event.status,
            routeId: event.routeId,
          });
        },
      },
    })(req as never, res as never);

    expect(responses).toEqual([{ adapter: "node", status: 200, routeId: "node-home" }]);
  });

  it("adds Lambda invocation metadata to observability events when context is provided", async () => {
    const responses: Array<Record<string, unknown>> = [];
    const handler = createLambdaHandler({
      routes: [{ id: "lambda-home", path: "/", render: () => "<h1>Lambda</h1>" }],
      observability: {
        onResponse: (event) => {
          responses.push({
            adapter: event.adapter,
            runtime: event.runtime,
            status: event.status,
            routeId: event.routeId,
            awsRequestId: event.metadata?.awsRequestId,
            functionName: event.metadata?.functionName,
          });
        },
      },
    });

    const response = await handler(lambdaEvent(), {
      awsRequestId: "aws-request-1",
      functionName: "tachyon-admin",
    });

    expect(response.statusCode).toBe(200);
    expect(responses).toEqual([
      {
        adapter: "lambda",
        runtime: "aws-lambda",
        status: 200,
        routeId: "lambda-home",
        awsRequestId: "aws-request-1",
        functionName: "tachyon-admin",
      },
    ]);
  });

  it("creates a Workers fetch handler with security headers", async () => {
    const routes: RouteDefinition[] = [{ path: "/", render: () => "<h1>Home</h1>" }];
    const handler = createWorkersHandler({
      routes,
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "abc" }),
    });

    const response = await handler.fetch(new Request("https://example.com/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("'nonce-abc'");
    expect(await response.text()).toBe("<h1>Home</h1>");
  });

  it("creates a Node handler that writes status, headers, and body", async () => {
    const routes: RouteDefinition[] = [{ path: "/", render: () => "<h1>Home</h1>" }];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string) => {
        if (chunk) {
          chunks.push(chunk);
        }
      }),
    };

    await createNodeHandler({ routes })(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/html; charset=utf-8");
    expect(chunks.join("")).toBe("<h1>Home</h1>");
  });

  it("preserves route-boundary 404 status and body across server adapters", async () => {
    const routes: RouteDefinition[] = [
      { path: "/", render: () => "home", notFound: ({ url }) => `<h1>Missing ${url.pathname}</h1>` },
    ];
    const workersResponse = await createWorkersHandler({ routes }).fetch(new Request("https://example.com/missing"));
    expect(workersResponse.status).toBe(404);
    expect(workersResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await workersResponse.text()).toBe("<h1>Missing /missing</h1>");

    const lambdaResponse = await createLambdaHandler({ routes })(lambdaEvent({ rawPath: "/missing" }));
    expect(lambdaResponse.statusCode).toBe(404);
    expect(lambdaResponse.headers?.["content-type"]).toBe("text/html; charset=utf-8");
    expect(lambdaResponse.body).toBe("<h1>Missing /missing</h1>");

    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/missing";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string) => {
        if (chunk) chunks.push(chunk);
      }),
    };
    await createNodeHandler({ routes })(req as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/html; charset=utf-8");
    expect(chunks.join("")).toBe("<h1>Missing /missing</h1>");
  });

  it("preserves generic invalid path encoding 400 responses across server adapters", async () => {
    let renderCalls = 0;
    const routes: RouteDefinition[] = [
      {
        path: "/safe",
        render: () => {
          renderCalls += 1;
          return "item";
        },
      },
    ];
    const workersResponse = await createWorkersHandler({ routes }).fetch(new Request("https://example.com/%zz"));
    expect(workersResponse.status).toBe(400);
    expect(await workersResponse.text()).toBe("<h1>Bad Request</h1>");

    const lambdaResponse = await createLambdaHandler({ routes })(lambdaEvent({ rawPath: "/%zz" }));
    expect(lambdaResponse.statusCode).toBe(400);
    expect(lambdaResponse.body).toBe("<h1>Bad Request</h1>");

    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/%zz";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string) => {
        if (chunk) chunks.push(chunk);
      }),
    };
    await createNodeHandler({ routes })(req as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(chunks.join("")).toBe("<h1>Bad Request</h1>");
    expect(renderCalls).toBe(0);
  });

  it.each([204, 205, 304])("removes bodies and transfer headers for status %i across adapters", async (status) => {
    const routes: RouteDefinition[] = [
      {
        path: "/submit",
        action: () =>
          json(
            { unexpected: true },
            {
              status,
              headers: { "content-length": "19", "transfer-encoding": "chunked", "x-kept": "yes" },
            },
          ),
        render: () => "unused",
      },
    ];

    for (const streaming of [false, true]) {
      const workers = await createWorkersHandler({ routes, streaming }).fetch(
        new Request("https://example.com/submit", { method: "POST" }),
      );
      expect(workers.status).toBe(status);
      expect(new Uint8Array(await workers.arrayBuffer())).toHaveLength(0);
      expect(workers.headers.get("content-length")).toBeNull();
      expect(workers.headers.get("transfer-encoding")).toBeNull();
      expect(workers.headers.get("x-kept")).toBe("yes");

      const lambda = await createLambdaHandler({ routes, streaming })(
        lambdaEvent({
          rawPath: "/submit",
          requestContext: { domainName: "lambda.example", http: { method: "POST", path: "/submit" } },
        }),
      );
      expect(lambda.statusCode).toBe(status);
      expect(lambda.body).toBe("");
      expect(lambda.headers["content-length"]).toBeUndefined();
      expect(lambda.headers["transfer-encoding"]).toBeUndefined();
      expect(lambda.headers["x-kept"]).toBe("yes");

      const nodeBytes: Uint8Array[] = [];
      const nodeRequest = Object.assign(Readable.from([]), {
        method: "POST",
        url: "/submit",
        headers: { host: "example.test" },
      });
      const nodeResponse = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: false,
        setHeader: vi.fn(),
        write: (chunk: Uint8Array) => {
          nodeBytes.push(Buffer.from(chunk));
          return true;
        },
        end: (chunk?: Uint8Array) => {
          if (chunk) nodeBytes.push(Buffer.from(chunk));
          nodeResponse.writableEnded = true;
        },
      });
      await createNodeHandler({ routes, streaming })(nodeRequest as never, nodeResponse as never);
      expect(nodeResponse.statusCode).toBe(status);
      expect(Buffer.concat(nodeBytes)).toHaveLength(0);
      expect(nodeResponse.setHeader).not.toHaveBeenCalledWith("content-length", expect.anything());
      expect(nodeResponse.setHeader).not.toHaveBeenCalledWith("transfer-encoding", expect.anything());
      expect(nodeResponse.setHeader).toHaveBeenCalledWith("x-kept", "yes");
    }
  });

  it("contains unexpected Node handler failures before headers are sent", async () => {
    const request = Object.assign(Readable.from([]), {
      method: "GET",
      url: "/failure",
      headers: { host: "example.test" },
    });
    const chunks: Uint8Array[] = [];
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      setHeader: vi.fn(),
      write: (chunk: Uint8Array) => {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      end: (chunk?: Uint8Array) => {
        if (chunk) chunks.push(Buffer.from(chunk));
        response.writableEnded = true;
      },
      destroy: vi.fn(),
    });

    await expect(
      createNodeHandler({
        routes: [{ path: "/failure", render: () => "unused" }],
        middleware: [() => { throw new Error("private failure detail"); }],
        securityHeaders: createSecurityHeaders(),
      })(request as never, response as never),
    ).resolves.toBeUndefined();

    expect(response.statusCode).toBe(500);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("Internal Server Error");
    expect(response.setHeader).toHaveBeenCalledWith("x-content-type-options", "nosniff");
    expect(response.destroy).not.toHaveBeenCalled();
  });

  it("aborts the Node fetch request signal when the client connection closes", async () => {
    const req = new Readable({ read() {} }) as Readable & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/events";
    req.headers = { host: "example.com" };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    let signal: AbortSignal | undefined;

    await createNodeFetchHandler({
      fetch: async (request) => {
        signal = request.signal;
        (req as typeof req & { aborted?: boolean }).aborted = true;
        req.emit("close");
        await delay(0);
        return new Response("ok");
      },
    })(req as never, res as never);

    expect(signal?.aborted).toBe(true);
  });

  it("cancels a streamed Node response body when the client connection closes", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        start(nextController) {
          controller = nextController;
          nextController.enqueue(new TextEncoder().encode("event: ready\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      setHeader: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    res.statusCode = 200;
    res.setHeader = vi.fn();
    res.end = vi.fn();
    res.write = vi.fn(() => {
      queueMicrotask(() => res.emit("close"));
      return true;
    });
    const writer = writeNodeResponse(new Response(body), res as never);

    try {
      const outcome = await Promise.race([writer.then(() => "done"), delay(20).then(() => "timeout")]);
      expect(outcome).toBe("done");
      expect(cancelled).toBe(true);
      expect(res.end).not.toHaveBeenCalled();
    } finally {
      try {
        controller?.close();
      } catch {
        // Already cancelled by the implementation under test.
      }
      await writer.catch(() => undefined);
    }
  });

  it("cancels a streamed Node response body when the response emits an error", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
        nextController.enqueue(new TextEncoder().encode("event: ready\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      setHeader: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    res.statusCode = 200;
    res.setHeader = vi.fn();
    res.end = vi.fn();
    res.write = vi.fn(() => {
      queueMicrotask(() => res.emit("error", new Error("connection reset")));
      return true;
    });
    const writer = writeNodeResponse(new Response(body), res as never);

    try {
      const outcome = await Promise.race([writer.then(() => "done"), delay(20).then(() => "timeout")]);
      expect(outcome).toBe("done");
      expect(cancelled).toBe(true);
      expect(res.end).not.toHaveBeenCalled();
    } finally {
      try {
        controller?.close();
      } catch {
        // Already cancelled by the implementation under test.
      }
      await writer.catch(() => undefined);
    }
  });

  it("flushes Node response headers before waiting for the first streamed body chunk", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const events: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      setHeader: ReturnType<typeof vi.fn>;
      flushHeaders: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    res.statusCode = 200;
    res.setHeader = vi.fn((name: string) => {
      events.push(`header:${name}`);
    });
    res.flushHeaders = vi.fn(() => {
      events.push("flush");
    });
    res.write = vi.fn((chunk: Buffer) => {
      events.push(`write:${chunk.toString("utf8")}`);
      return true;
    });
    res.end = vi.fn(() => {
      events.push("end");
    });
    const writer = writeNodeResponse(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      res as never,
    );

    await delay(0);
    const flushCallCountBeforeFirstChunk = res.flushHeaders.mock.calls.length;
    const writeCallCountBeforeFirstChunk = res.write.mock.calls.length;

    controller?.enqueue(new TextEncoder().encode(":ok\n\n"));
    controller?.close();
    await writer;

    expect(flushCallCountBeforeFirstChunk).toBe(1);
    expect(writeCallCountBeforeFirstChunk).toBe(0);

    expect(events.indexOf("flush")).toBeLessThan(events.findIndex((event) => event.startsWith("write:")));
  });

  it("writes streamed Node responses for minimal ServerResponse-compatible objects", async () => {
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      write: vi.fn((chunk: Buffer) => {
        chunks.push(chunk.toString("utf8"));
        return true;
      }),
      end: vi.fn(),
    };

    await writeNodeResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hello"));
            controller.close();
          },
        }),
      ),
      res as never,
    );

    expect(chunks.join("")).toBe("hello");
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("waits for drain before reading the next Node stream chunk", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("first"));
        else if (pulls === 2) controller.enqueue(new TextEncoder().encode("second"));
        else controller.close();
      },
    });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      setHeader: vi.fn(),
      write: vi.fn(() => false),
      end: vi.fn(),
    });
    const writing = writeNodeResponse(new Response(body), res as never);

    await Promise.resolve();
    await Promise.resolve();
    expect(res.write).toHaveBeenCalledTimes(1);
    res.emit("drain");
    res.write.mockReturnValueOnce(true);
    await writing;
  });

  it.each(["close", "error"] as const)("cancels a Node source when %s interrupts a drain wait", async (event) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      setHeader: vi.fn(),
      write: vi.fn(() => false),
      end: vi.fn(),
    });
    const writing = writeNodeResponse(new Response(body), res as never);
    await Promise.resolve();
    await Promise.resolve();

    res.emit(event, ...(event === "error" ? [new Error("connection reset")] : []));
    await expect(Promise.race([writing.then(() => "done"), delay(20).then(() => "timeout")])).resolves.toBe("done");
    expect(cancelled).toBe(true);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("forwards Workers stream cancellation to the route chunk iterator", async () => {
    const iterator = {
      next: vi.fn(async () => ({ done: false as const, value: "first" })),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const chunks = { [Symbol.asyncIterator]: () => iterator };
    const reader = workersStreamFromChunks(chunks).getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel("client disconnected");

    expect(iterator.next).toHaveBeenCalled();
    expect(iterator.return).toHaveBeenCalledOnce();
  });

  it("matches one-shot UTF-8 encoding at every application string chunk boundary", async () => {
    const corpus = ["ASCII", "雪", "e\u0301", "🙂", "🙂🙂", "A🙂B", "👩‍💻", "\ud83dX", "X\ude42", "\ud83d"];
    for (const value of corpus) {
      for (let split = 0; split <= value.length; split += 1) {
        const chunks = (async function* () {
          yield value.slice(0, split);
          yield value.slice(split);
        })();
        const actual = new Uint8Array(await new Response(workersStreamFromChunks(chunks)).arrayBuffer());
        expect(Array.from(actual), `${JSON.stringify(value)} split=${split}`).toEqual(
          Array.from(new TextEncoder().encode(value)),
        );
      }
    }
  });

  it("does not flush a pending high surrogate after cancellation or source failure", async () => {
    let resolveSecond!: (value: IteratorResult<string>) => void;
    const second = new Promise<IteratorResult<string>>((resolve) => {
      resolveSecond = resolve;
    });
    const iterator = {
      next: vi
        .fn<() => Promise<IteratorResult<string>>>()
        .mockResolvedValueOnce({ done: false, value: "\ud83d" })
        .mockReturnValueOnce(second),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const reader = workersStreamFromChunks({ [Symbol.asyncIterator]: () => iterator }).getReader();
    const reading = reader.read();
    await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledTimes(2));
    const cancelling = reader.cancel("disconnect");
    resolveSecond({ done: true, value: undefined });
    await expect(cancelling).resolves.toBeUndefined();
    await expect(reading).resolves.toEqual({ done: true, value: undefined });
    expect(iterator.return).toHaveBeenCalledOnce();

    const failing = workersStreamFromChunks(
      (async function* () {
        yield "\ud83d";
        throw new Error("source failed");
      })(),
    ).getReader();
    await expect(failing.read()).rejects.toThrow("source failed");
  });

  it("preserves a split surrogate pair through Workers, Node, Lambda proxy, and Lambda streaming", async () => {
    const expected = "A🙂B";
    const routes: RouteDefinition[] = [
      {
        path: "/unicode",
        render: () => "",
        stream: async function* () {
          yield "A\ud83d";
          yield "\ude42B";
        },
      },
    ];

    const workers = await createWorkersHandler({ routes, streaming: true }).fetch(
      new Request("https://example.test/unicode"),
    );
    expect(await workers.text()).toBe(expected);

    const nodeBytes: Uint8Array[] = [];
    const nodeRequest = Object.assign(Readable.from([]), {
      method: "GET",
      url: "/unicode",
      headers: { host: "example.test" },
    });
    const nodeResponse = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: (chunk: Uint8Array) => {
        nodeBytes.push(Buffer.from(chunk));
        return true;
      },
      end: () => {
        nodeResponse.writableEnded = true;
      },
    });
    await createNodeHandler({ routes, streaming: true })(nodeRequest as never, nodeResponse as never);
    expect(Buffer.concat(nodeBytes).toString("utf8")).toBe(expected);

    const lambdaProxy = await createLambdaHandler({ routes, streaming: true })(
      lambdaEvent({
        rawPath: "/unicode",
        requestContext: { domainName: "lambda.example", http: { method: "GET", path: "/unicode" } },
      }),
    );
    expect(lambdaProxy.body).toBe(expected);

    const lambdaBytes: Uint8Array[] = [];
    const responseStream = new Writable({
      write(chunk, _encoding, callback) {
        lambdaBytes.push(Buffer.from(chunk));
        callback();
      },
    });
    const runtime = {
      streamifyResponse: vi.fn((handler) => handler),
      HttpResponseStream: { from: vi.fn((stream: Writable) => stream) },
    };
    const lambdaStreaming = createLambdaStreamingHandler({ routes, streaming: true }, runtime) as (
      event: ReturnType<typeof lambdaEvent>,
      stream: Writable,
      context: unknown,
    ) => Promise<void>;
    await lambdaStreaming(
      lambdaEvent({
        rawPath: "/unicode",
        requestContext: { domainName: "lambda.example", http: { method: "GET", path: "/unicode" } },
      }),
      responseStream,
      {},
    );
    expect(Buffer.concat(lambdaBytes).toString("utf8")).toBe(expected);
  });

  it("preserves middleware Response bytes through Workers, Node, Lambda proxy, and Lambda streaming", async () => {
    const expected = Uint8Array.from([0, 255, 254, 195, 40, 137, 80, 78, 71]);
    const routes: RouteDefinition[] = [{ path: "/binary", render: () => "unused" }];
    const middleware = [
      () =>
        new Response(expected.slice(), {
          status: 206,
          headers: { "content-type": "application/octet-stream", "x-binary": "yes" },
        }),
    ];

    const workers = await createWorkersHandler({ routes, middleware }).fetch(
      new Request("https://example.test/binary"),
    );
    expect(workers.status).toBe(206);
    expect(workers.headers.get("x-binary")).toBe("yes");
    expect(new Uint8Array(await workers.arrayBuffer())).toEqual(expected);

    const nodeBytes: Uint8Array[] = [];
    const nodeRequest = Object.assign(Readable.from([]), {
      method: "GET",
      url: "/binary",
      headers: { host: "example.test" },
    });
    const nodeResponse = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      setHeader: vi.fn(),
      write: (chunk: Uint8Array) => {
        nodeBytes.push(Buffer.from(chunk));
        return true;
      },
      end: (chunk?: Uint8Array) => {
        if (chunk) nodeBytes.push(Buffer.from(chunk));
        nodeResponse.writableEnded = true;
      },
    });
    await createNodeHandler({ routes, middleware })(nodeRequest as never, nodeResponse as never);
    expect(nodeResponse.statusCode).toBe(206);
    expect(Buffer.concat(nodeBytes)).toEqual(Buffer.from(expected));

    const lambdaProxy = await createLambdaHandler({ routes, middleware })(
      lambdaEvent({
        rawPath: "/binary",
        requestContext: { domainName: "lambda.example", http: { method: "GET", path: "/binary" } },
      }),
    );
    expect(lambdaProxy.statusCode).toBe(206);
    expect(lambdaProxy.isBase64Encoded).toBe(true);
    expect(lambdaProxy.body).toBe(Buffer.from(expected).toString("base64"));

    const lambdaBytes: Uint8Array[] = [];
    const responseStream = new Writable({
      write(chunk, _encoding, callback) {
        lambdaBytes.push(Buffer.from(chunk));
        callback();
      },
    });
    const runtime = {
      streamifyResponse: vi.fn((handler) => handler),
      HttpResponseStream: { from: vi.fn((stream: Writable) => stream) },
    };
    const lambdaStreaming = createLambdaStreamingHandler({ routes, middleware, streaming: true }, runtime) as (
      event: ReturnType<typeof lambdaEvent>,
      stream: Writable,
      context: unknown,
    ) => Promise<void>;
    await lambdaStreaming(
      lambdaEvent({
        rawPath: "/binary",
        requestContext: { domainName: "lambda.example", http: { method: "GET", path: "/binary" } },
      }),
      responseStream,
      {},
    );
    expect(Buffer.concat(lambdaBytes)).toEqual(Buffer.from(expected));
  });

  it.each([
    ["missing content type", undefined],
    ["invalid UTF-8 under a textual content type", "text/plain; charset=utf-8"],
  ])("base64-encodes native Lambda bytes with %s", async (_label, contentType) => {
    const expected = Uint8Array.from([0, 255, 254, 195, 40, 137, 80, 78, 71]);
    const response = new Response(expected.slice(), contentType ? { headers: { "content-type": contentType } } : {});

    const lambda = await lambdaResponseFromWebResponse(response);

    expect(lambda.isBase64Encoded).toBe(true);
    expect(Uint8Array.from(Buffer.from(lambda.body, "base64"))).toEqual(expected);
  });

  it("preserves native 304 representation length across adapters", async () => {
    const routes: RouteDefinition[] = [{ path: "/cached", render: () => "unused" }];
    const middleware = [() => new Response(null, { status: 304, headers: { "content-length": "123" } })];

    const core = await createWorkersHandler({ routes, middleware }).fetch(new Request("https://example.test/cached"));
    const lambda = await createLambdaHandler({ routes, middleware })(
      lambdaEvent({ rawPath: "/cached", requestContext: { http: { method: "GET", path: "/cached" } } }),
    );
    const nodeRequest = Object.assign(Readable.from([]), {
      method: "GET",
      url: "/cached",
      headers: { host: "example.test" },
    });
    const nodeHeaders = new Map<string, string | number | readonly string[]>();
    const nodeChunks: string[] = [];
    const nodeResponse = {
      statusCode: 200,
      setHeader: (name: string, value: string | number | readonly string[]) => nodeHeaders.set(name, value),
      end: (chunk?: string) => nodeChunks.push(chunk ?? ""),
    };
    await createNodeHandler({ routes, middleware })(nodeRequest as never, nodeResponse as never);

    expect(core.status).toBe(304);
    expect(core.headers.get("content-length")).toBe("123");
    expect(await core.text()).toBe("");
    expect(lambda.statusCode).toBe(304);
    expect(lambda.headers["content-length"]).toBe("123");
    expect(lambda.body).toBe("");
    expect(nodeResponse.statusCode).toBe(304);
    expect(nodeHeaders.get("content-length")).toBe("123");
    expect(nodeChunks.join("")).toBe("");
  });

  it("preserves multiple Set-Cookie headers in Node fetch responses", async () => {
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
    headers.append("set-cookie", "sid=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "theme=dark; Path=/");
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      fetch: () => new Response("ok", { headers }),
    })(req as never, res as never);

    expect(res.setHeader).toHaveBeenCalledWith("set-cookie", ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/plain; charset=utf-8");
  });

  it("rejects untrusted Node Host headers and gates forwarded proto trust", async () => {
    const seenUrls: string[] = [];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/account";
    req.headers = { host: "evil.example", "x-forwarded-proto": "https" };
    const rejected = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      trustedHosts: ["app.example"],
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, rejected as never);

    expect(rejected.statusCode).toBe(400);
    expect(seenUrls).toEqual([]);

    req.headers = { host: "app.example", "x-forwarded-proto": "https" };
    const accepted = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      trustedHosts: ["app.example"],
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, accepted as never);

    expect(seenUrls.at(-1)).toBe("http://app.example/account");

    await createNodeFetchHandler({
      trustProxy: true,
      trustedHosts: ["app.example"],
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, accepted as never);

    expect(seenUrls.at(-1)).toBe("https://app.example/account");
  });

  it.each([undefined, "", "javascript", "file", "https://evil.example/#", "http,https"])(
    "rejects invalid trusted forwarded protocol %j",
    async (forwardedProtocol) => {
      const seenUrls: string[] = [];
      const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
        method: string;
        url: string;
        headers: Record<string, string | undefined>;
      };
      req.method = "GET";
      req.url = "/admin";
      req.headers = { host: "app.example", "x-forwarded-proto": forwardedProtocol };
      const res = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      await createNodeFetchHandler({
        trustProxy: true,
        trustedHosts: ["app.example"],
        fetch: (request) => {
          seenUrls.push(request.url);
          return new Response("ok");
        },
      })(req as never, res as never);

      expect(res.statusCode).toBe(400);
      expect(seenUrls).toEqual([]);
    },
  );

  it("normalizes a valid trusted forwarded protocol without changing the request path", async () => {
    const seenUrls: string[] = [];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/admin?mode=edit";
    req.headers = { host: "app.example", "x-forwarded-proto": " HTTPS " };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      trustProxy: true,
      trustedHosts: ["app.example"],
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, res as never);

    expect(seenUrls).toEqual(["https://app.example/admin?mode=edit"]);
  });

  it("uses a fixed Node origin without reading forwarded protocol metadata", async () => {
    const seenUrls: string[] = [];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/admin";
    req.headers = { host: "evil.example", "x-forwarded-proto": "javascript" };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      origin: "https://fixed.example",
      trustProxy: true,
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, res as never);

    expect(seenUrls).toEqual(["https://fixed.example/admin"]);
  });

  it("does not derive Node request origins from Host unless trust is explicit", async () => {
    const seenUrls: string[] = [];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/account";
    req.headers = { host: "evil.example", "x-forwarded-proto": "https" };
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeFetchHandler({
      fetch: (request) => {
        seenUrls.push(request.url);
        return new Response("ok");
      },
    })(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(seenUrls).toEqual(["http://localhost/account"]);
  });

  it("rejects untrusted Lambda fallback Host headers", () => {
    expect(() =>
      requestFromLambdaEvent(
        lambdaEvent({
          headers: { host: "evil.example" },
          requestContext: { http: { method: "GET", path: "/" } },
        }),
        { trustedHosts: ["app.example"] },
      ),
    ).toThrow("Untrusted Host header");

    const request = requestFromLambdaEvent(
      lambdaEvent({
        headers: { host: "app.example" },
        requestContext: { http: { method: "GET", path: "/" } },
      }),
      { trustedHosts: ["app.example"] },
    );
    expect(request.url).toBe("https://app.example/");
  });

  it("does not derive Lambda fallback origins from Host unless trust is explicit", () => {
    const request = requestFromLambdaEvent(
      lambdaEvent({
        rawPath: "/account",
        headers: { host: "evil.example" },
        requestContext: { http: { method: "GET", path: "/account" } },
      }),
    );

    expect(request.url).toBe("https://localhost/account");
  });

  it("preserves Set-Cookie arrays for Node static routes and assets", async () => {
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const routeRes = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await createNodeHandler({
      routes: [{ path: "/", render: () => "<h1>Dynamic</h1>" }],
      staticRoutes: [
        {
          path: "/",
          body: "<h1>Static</h1>",
          headers: [
            ["set-cookie", "a=1; Path=/"],
            ["set-cookie", "b=2; Path=/"],
          ],
        },
      ],
    })(req as never, routeRes as never);

    expect(routeRes.setHeader).toHaveBeenCalledWith("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);

    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-node-assets-"));
    try {
      await writeFile(path.join(dir, "app.txt"), "asset");
      req.url = "/app.txt";
      const assetRes = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: vi.fn(),
      };
      await createNodeFetchHandler({
        staticAssets: {
          rootDir: dir,
          headers: [
            ["set-cookie", "asset=1; Path=/"],
            ["set-cookie", "asset2=1; Path=/"],
          ],
        },
        fetch: () => new Response("dynamic"),
      })(req as never, assetRes as never);

      expect(assetRes.setHeader).toHaveBeenCalledWith("set-cookie", ["asset=1; Path=/", "asset2=1; Path=/"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves static Node routes before the dynamic router", async () => {
    const render = vi.fn(() => "<h1>Dynamic</h1>");
    const routes: RouteDefinition[] = [{ path: "/", render }];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string) => {
        if (chunk) {
          chunks.push(chunk);
        }
      }),
    };

    await createNodeHandler({ routes, staticRoutes: [{ path: "/", body: "<h1>Static</h1>" }] })(
      req as never,
      res as never,
    );

    expect(render).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/html; charset=utf-8");
    expect(res.setHeader).toHaveBeenCalledWith("content-length", "15");
    expect(chunks.join("")).toBe("<h1>Static</h1>");
  });

  it("serves static Workers routes before the dynamic router", async () => {
    const render = vi.fn(() => "<h1>Dynamic</h1>");
    const handler = createWorkersHandler({
      routes: [{ path: "/", render }],
      staticRoutes: [{ path: "/", body: "<h1>Static</h1>" }],
    });

    const response = await handler.fetch(new Request("https://example.com/"));

    expect(render).not.toHaveBeenCalled();
    expect(response.headers.get("content-length")).toBe("15");
    expect(await response.text()).toBe("<h1>Static</h1>");
  });

  it("locks static dispatch before route middleware across adapters", async () => {
    const middleware = vi.fn(() => new Response("denied", { status: 403 }));
    const routes: RouteDefinition[] = [{ path: "/admin", render: () => "dynamic" }];
    const staticRoutes = [{ path: "/admin", body: "static" }];

    const workers = await createWorkersHandler({ routes, staticRoutes, middleware: [middleware] }).fetch(
      new Request("https://example.com/admin"),
    );
    const lambda = await createLambdaHandler({ routes, staticRoutes, middleware: [middleware] })(
      lambdaEvent({ rawPath: "/admin", requestContext: { http: { method: "GET", path: "/admin" } } }),
    );
    const nodeRequest = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    nodeRequest.method = "GET";
    nodeRequest.url = "/admin";
    nodeRequest.headers = { host: "example.com" };
    const nodeChunks: string[] = [];
    const nodeResponse = { statusCode: 200, setHeader: vi.fn(), end: (chunk?: string) => nodeChunks.push(chunk ?? "") };
    await createNodeHandler({ routes, staticRoutes, middleware: [middleware] })(
      nodeRequest as never,
      nodeResponse as never,
    );

    expect(await workers.text()).toBe("static");
    expect(lambda).toMatchObject({ statusCode: 200, body: "static" });
    expect(nodeChunks.join("")).toBe("static");
    expect(middleware).not.toHaveBeenCalled();
  });

  it("runs route middleware only after configured asset sources fall through", async () => {
    const middleware = vi.fn(() => new Response("denied", { status: 403 }));
    const routes: RouteDefinition[] = [{ path: "/admin", render: () => "dynamic" }];
    const assetHit = await createWorkersHandler({
      routes,
      middleware: [middleware],
      assets: { binding: { fetch: () => new Response("asset") } },
    }).fetch(new Request("https://example.com/admin"));
    const assetMiss = await createWorkersHandler({
      routes,
      middleware: [middleware],
      assets: { binding: { fetch: () => new Response("missing", { status: 404 }) } },
    }).fetch(new Request("https://example.com/admin"));

    expect(await assetHit.text()).toBe("asset");
    expect(assetMiss.status).toBe(403);
    expect(await assetMiss.text()).toBe("denied");
    expect(middleware).toHaveBeenCalledTimes(1);
  });

  it("documents the static dispatch trust boundary", async () => {
    const routing = await readFile("docs/routing.md", "utf8");
    const security = await readFile("docs/security.md", "utf8");

    expect(routing).toContain("static routes and assets are resolved before route middleware");
    expect(routing).toContain("route middleware must not be used to authorize static content");
    expect(routing).toContain("staticRoutes -> assets -> route middleware and route matching -> NotFound");
    expect(security).toContain("Static routes and assets are outside route middleware authorization");
    expect(security).toContain("an omitted asset base path matches every request path");
  });

  it("preserves streaming redirects through Workers responses", async () => {
    const handler = createWorkersHandler({
      routes: [
        {
          path: "/private",
          fallback: "<p>Loading</p>",
          loader: () => redirect("/login"),
          render: () => "<h1>Private</h1>",
        },
      ],
      streaming: true,
    });

    const response = await handler.fetch(new Request("https://example.com/private"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    expect(await response.text()).toBe("");
  });

  it("commits authoritative route metadata before an asynchronous personalized stream", async () => {
    const handler = createWorkersHandler({
      routes: [
        {
          path: "/account",
          fallback: "<p>Loading account</p>",
          loader: async ({ request }) => {
            await delay(10);
            return request.headers.get("cookie") ?? "anonymous";
          },
          cache: { mode: "no-store" },
          headers: () => {
            const headers = new Headers({
              "content-security-policy": "default-src 'self'",
              vary: "Cookie, Accept-Encoding",
            });
            headers.append("set-cookie", "sid=updated; Path=/; HttpOnly");
            headers.append("set-cookie", "theme=dark; Path=/");
            return headers;
          },
          render: ({ data }) => `<h1>${data}</h1>`,
        },
      ],
      streaming: true,
    });

    const response = await handler.fetch(new Request("https://example.com/account", { headers: { cookie: "sid=a" } }));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(response.headers.getSetCookie()).toEqual(["sid=updated; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Encoding");
    expect(await response.text()).toBe("<h1>sid=a</h1>");
  });

  it("commits delayed streaming CSRF rejection before status and fallback", async () => {
    type Bindings = { sessions: { verify: (request: Request) => Promise<boolean> } };
    const action = vi.fn(() => "saved");
    const bindings: Bindings = {
      sessions: {
        verify: async () => {
          await delay(10);
          return false;
        },
      },
    };
    const handler = createWorkersHandler<Bindings>({
      routes: [{ path: "/action", fallback: "secret fallback", action, render: () => "ok" }],
      csrf: { verify: ({ request }) => bindings.sessions.verify(request) },
      streaming: true,
    });

    const response = await handler.fetch(new Request("https://example.com/action", { method: "POST" }), bindings);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("<h1>Forbidden</h1>");
    expect(action).not.toHaveBeenCalled();
  });

  it("passes typed Workers invocation bindings to CSRF verification", async () => {
    type Bindings = { sessions: { verify: (request: Request) => Promise<boolean> } };
    const bindings: Bindings = { sessions: { verify: async () => false } };
    let verifierBindings: Bindings | undefined;
    const handler = createWorkersHandler<Bindings>({
      routes: [{ path: "/action", action: () => "saved", render: () => "ok" }],
      csrf: {
        verify: ({ request, bindings: seen }) => {
          verifierBindings = seen;
          return seen.sessions.verify(request);
        },
      },
    });

    const response = await handler.fetch(new Request("https://example.com/action", { method: "POST" }), bindings);

    expect(response.status).toBe(403);
    expect(verifierBindings).toBe(bindings);
  });

  it("preserves authoritative streaming metadata and delayed CSRF commit policies through Node and Lambda", async () => {
    const action = vi.fn(() => "saved");
    const routes: RouteDefinition[] = [
      {
        path: "/account",
        fallback: "secret fallback",
        loader: async () => {
          await delay(10);
          return "private account";
        },
        action,
        cache: { mode: "no-store" },
        headers: () => {
          const headers = new Headers({
            "content-security-policy": "default-src 'self'",
            vary: "Cookie, Accept-Encoding",
          });
          headers.append("set-cookie", "sid=updated; Path=/; HttpOnly");
          headers.append("set-cookie", "theme=dark; Path=/");
          return headers;
        },
        render: ({ data }) => `<h1>${data}</h1>`,
      },
    ];
    const nodeRequest = (method: string) =>
      Object.assign(Readable.from([]), {
        method,
        url: "/account",
        headers: { host: "example.com", cookie: "sid=a" },
      });
    const nodeResponse = () => {
      const headers = new Map<string, string | number | readonly string[]>();
      const chunks: string[] = [];
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: false,
        setHeader: (name: string, value: string | number | readonly string[]) => headers.set(name, value),
        flushHeaders: () => undefined,
        write: (chunk: Uint8Array) => {
          chunks.push(Buffer.from(chunk).toString("utf8"));
          return true;
        },
        end: (chunk?: string) => {
          if (chunk) chunks.push(chunk);
          response.writableEnded = true;
        },
      });
      return { response, headers, chunks };
    };

    const nodeGet = nodeResponse();
    await createNodeHandler({ routes, streaming: true })(nodeRequest("GET") as never, nodeGet.response as never);
    expect(nodeGet.headers.get("cache-control")).toBe("no-store");
    expect(nodeGet.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(nodeGet.headers.get("set-cookie")).toEqual(["sid=updated; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(nodeGet.headers.get("vary")).toBe("Cookie, Accept-Encoding");
    expect(nodeGet.chunks.join("")).toBe("<h1>private account</h1>");

    const nodePost = nodeResponse();
    await createNodeHandler({
      routes,
      streaming: true,
      csrf: {
        verify: async () => {
          await delay(10);
          return false;
        },
      },
    })(nodeRequest("POST") as never, nodePost.response as never);
    expect(nodePost.response.statusCode).toBe(403);
    expect(nodePost.chunks.join("")).toBe("<h1>Forbidden</h1>");

    const lambdaGet = await createLambdaHandler({ routes, streaming: true })(
      lambdaEvent({
        rawPath: "/account",
        requestContext: { domainName: "lambda.example", http: { method: "GET", path: "/account" } },
      }),
    );
    expect(lambdaGet.headers["cache-control"]).toBe("no-store");
    expect(lambdaGet.headers["content-security-policy"]).toBe("default-src 'self'");
    expect(lambdaGet.headers.vary).toBe("Cookie, Accept-Encoding");
    expect(lambdaGet.cookies).toEqual(["sid=updated; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(lambdaGet.body).toBe("<h1>private account</h1>");

    const lambdaPost = await createLambdaHandler({
      routes,
      streaming: true,
      csrf: {
        verify: async () => {
          await delay(10);
          return false;
        },
      },
    })(
      lambdaEvent({
        rawPath: "/account",
        requestContext: { domainName: "lambda.example", http: { method: "POST", path: "/account" } },
      }),
    );
    expect(lambdaPost.statusCode).toBe(403);
    expect(lambdaPost.body).toBe("<h1>Forbidden</h1>");
    expect(action).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves delayed HEAD metadata without emitting bodies across adapters with streaming=$streaming",
    async (streaming) => {
      const routes: RouteDefinition[] = [
        {
          path: "/head",
          loader: async () => {
            await delay(10);
            return "ready";
          },
          cache: { mode: "no-store" },
          headers: { vary: "Cookie" },
          render: ({ data }) => `<h1>${data}</h1>`,
        },
      ];

      const workers = await createWorkersHandler({ routes, streaming }).fetch(
        new Request("https://example.com/head", { method: "HEAD" }),
      );
      expect(workers.headers.get("cache-control")).toBe("no-store");
      expect(workers.headers.get("vary")).toBe("Cookie");
      expect(await workers.text()).toBe("");

      const nodeChunks: string[] = [];
      const nodeRequest = Object.assign(Readable.from([]), {
        method: "HEAD",
        url: "/head",
        headers: { host: "example.com" },
      });
      const nodeHeaders = new Map<string, string | number | readonly string[]>();
      const nodeResponse = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableEnded: false,
        setHeader: (name: string, value: string | number | readonly string[]) => nodeHeaders.set(name, value),
        flushHeaders: () => undefined,
        write: (chunk: Uint8Array) => {
          nodeChunks.push(Buffer.from(chunk).toString("utf8"));
          return true;
        },
        end: (chunk?: string) => {
          if (chunk) nodeChunks.push(chunk);
          nodeResponse.writableEnded = true;
        },
      });
      await createNodeHandler({ routes, streaming })(nodeRequest as never, nodeResponse as never);
      expect(nodeHeaders.get("cache-control")).toBe("no-store");
      expect(nodeHeaders.get("vary")).toBe("Cookie");
      expect(nodeChunks).toEqual([]);

      const lambda = await createLambdaHandler({ routes, streaming })(
        lambdaEvent({
          rawPath: "/head",
          requestContext: { domainName: "lambda.example", http: { method: "HEAD", path: "/head" } },
        }),
      );
      expect(lambda.headers["cache-control"]).toBe("no-store");
      expect(lambda.headers.vary).toBe("Cookie");
      expect(lambda.body).toBe("");

      if (!streaming) {
        return;
      }
      const metadata = vi.fn((stream: Writable) => stream);
      const runtime = {
        streamifyResponse: vi.fn((handler) => handler),
        HttpResponseStream: { from: metadata },
      };
      const lambdaChunks: string[] = [];
      const responseStream = new Writable({
        write(chunk, _encoding, callback) {
          lambdaChunks.push(Buffer.from(chunk).toString("utf8"));
          callback();
        },
      });
      const streamingHandler = createLambdaStreamingHandler({ routes, streaming: true }, runtime) as (
        event: ReturnType<typeof lambdaEvent>,
        responseStream: Writable,
        context: unknown,
      ) => Promise<void>;
      await streamingHandler(
        lambdaEvent({
          rawPath: "/head",
          requestContext: { domainName: "lambda.example", http: { method: "HEAD", path: "/head" } },
        }),
        responseStream,
        {},
      );
      expect(metadata).toHaveBeenCalledWith(
        responseStream,
        expect.objectContaining({ headers: expect.objectContaining({ "cache-control": "no-store", vary: "Cookie" }) }),
      );
      expect(lambdaChunks).toEqual([]);
    },
  );

  it("preserves delayed redirects and cookies across streaming adapters", async () => {
    const routes: RouteDefinition[] = [
      {
        path: "/private",
        fallback: "secret fallback",
        loader: async () => {
          await delay(10);
          return redirect("/login", { headers: { "set-cookie": "return-to=/private; Path=/" } });
        },
        render: () => "<h1>Private</h1>",
      },
    ];

    const workers = await createWorkersHandler({ routes, streaming: true }).fetch(
      new Request("https://example.com/private"),
    );
    expect(workers.status).toBe(302);
    expect(workers.headers.get("location")).toBe("/login");
    expect(workers.headers.get("set-cookie")).toBe("return-to=/private; Path=/");
    expect(await workers.text()).toBe("");

    const nodeHeaders = new Map<string, string | number | readonly string[]>();
    const nodeChunks: string[] = [];
    const nodeRequest = Object.assign(Readable.from([]), {
      method: "GET",
      url: "/private",
      headers: { host: "example.com" },
    });
    const nodeResponse = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      setHeader: (name: string, value: string | number | readonly string[]) => nodeHeaders.set(name, value),
      flushHeaders: () => undefined,
      write: (chunk: Uint8Array) => {
        nodeChunks.push(Buffer.from(chunk).toString("utf8"));
        return true;
      },
      end: (chunk?: string) => {
        if (chunk) nodeChunks.push(chunk);
        nodeResponse.writableEnded = true;
      },
    });
    await createNodeHandler({ routes, streaming: true })(nodeRequest as never, nodeResponse as never);
    expect(nodeResponse.statusCode).toBe(302);
    expect(nodeHeaders.get("location")).toBe("/login");
    expect(nodeHeaders.get("set-cookie")).toBe("return-to=/private; Path=/");
    expect(nodeChunks).toEqual([]);

    const lambda = await createLambdaHandler({ routes, streaming: true })(
      lambdaEvent({
        rawPath: "/private",
        requestContext: { domainName: "lambda.example", http: { method: "GET", path: "/private" } },
      }),
    );
    expect(lambda.statusCode).toBe(302);
    expect(lambda.headers.location).toBe("/login");
    expect(lambda.cookies).toEqual(["return-to=/private; Path=/"]);
    expect(lambda.body).toBe("");

    const metadata = vi.fn((stream: Writable) => stream);
    const runtime = {
      streamifyResponse: vi.fn((handler) => handler),
      HttpResponseStream: { from: metadata },
    };
    const responseStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const streamingHandler = createLambdaStreamingHandler({ routes, streaming: true }, runtime) as (
      event: ReturnType<typeof lambdaEvent>,
      responseStream: Writable,
      context: unknown,
    ) => Promise<void>;
    await streamingHandler(
      lambdaEvent({
        rawPath: "/private",
        requestContext: { domainName: "lambda.example", http: { method: "GET", path: "/private" } },
      }),
      responseStream,
      {},
    );
    expect(metadata).toHaveBeenCalledWith(
      responseStream,
      expect.objectContaining({
        statusCode: 302,
        headers: expect.objectContaining({ location: "/login" }),
        multiValueHeaders: { "Set-Cookie": ["return-to=/private; Path=/"] },
      }),
    );
  });

  it("shares safe buffered HTML condensation across Workers, Node, and Lambda", async () => {
    const routes: RouteDefinition[] = [
      {
        path: "/",
        render: () =>
          `<!doctype html><html><head><meta   charset="UTF-8"   /></head><body><!--tachyon-hydrate:x:start--><p>Hello <!---->Ada</p><!--tachyon-hydrate:x:end--></body></html>`,
      },
    ];
    const expected = `<!doctype html><html><head><meta charset="UTF-8" /></head><body><!--tachyon-hydrate:x:start--><p>Hello <!---->Ada</p><!--tachyon-hydrate:x:end--></body></html>`;

    const workers = await createWorkersHandler({ routes, htmlWhitespace: "normalize-tags" }).fetch(
      new Request("https://example.test/"),
    );
    expect(await workers.text()).toBe(expected);
    const legacyWorkers = await createWorkersHandler({ routes, htmlWhitespace: "condense" as never }).fetch(
      new Request("https://example.test/"),
    );
    expect(await legacyWorkers.text()).toBe(expected);
    const invalidWorkers = await createWorkersHandler({ routes, htmlWhitespace: "unknown" as never }).fetch(
      new Request("https://example.test/"),
    );
    expect(invalidWorkers.status).toBe(500);

    const lambda = await createLambdaHandler({ routes, htmlWhitespace: "normalize-tags" })(lambdaEvent());
    expect(lambda.body).toBe(expected);
    const legacyLambda = await createLambdaHandler({ routes, htmlWhitespace: "condense" as never })(lambdaEvent());
    expect(legacyLambda.body).toBe(expected);

    const chunks: string[] = [];
    const request = Object.assign(Readable.from([]), { method: "GET", url: "/", headers: { host: "example.test" } });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk: Uint8Array) => {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        return true;
      },
      end: (chunk?: string) => {
        if (chunk) chunks.push(chunk);
        response.writableEnded = true;
      },
    });
    await createNodeHandler({ routes, htmlWhitespace: "normalize-tags" })(request as never, response as never);
    expect(chunks.join("")).toBe(expected);
  });

  it("serves Cloudflare assets from env binding with security headers", async () => {
    const assetFetch = vi.fn((request: Request) => {
      expect(new URL(request.url).pathname).toBe("/assets/app.js");
      return new Response(`console.log("asset");`, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    });
    const render = vi.fn(() => "<h1>Dynamic</h1>");
    const handler = createWorkersHandler<{ ASSETS: { fetch: typeof assetFetch } }>({
      routes: [{ path: "/", render }],
      assets: { bindingName: "ASSETS", basePath: "/assets" },
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
    });

    const response = await handler.fetch(new Request("https://example.com/assets/app.js"), {
      ASSETS: { fetch: assetFetch },
    });

    expect(assetFetch).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
    expect(response.headers.get("content-security-policy")).toContain("'nonce-asset-nonce'");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe(`console.log("asset");`);
  });

  it("passes typed Workers invocation bindings through every route callback", async () => {
    type Bindings = {
      RUNTIME_NAME: string;
      KV: { get: (key: string) => Promise<string> };
      DB: { prepare: (query: string) => { query: string } };
    };
    const seen = new Set<string>();
    const assertBindings = (bindings: Bindings): void => {
      expect(bindings.RUNTIME_NAME).toBe("edge");
      expect(bindings.DB.prepare("select 1").query).toBe("select 1");
    };
    const handler = createWorkersHandler<Bindings>({
      env: { RUNTIME_NAME: "configured" },
      middleware: [
        ({ bindings, env }) => {
          assertBindings(bindings);
          expect(env.RUNTIME_NAME).toBe("configured");
          seen.add("middleware");
        },
      ],
      routes: [
        {
          path: "/",
          action: ({ bindings }) => {
            assertBindings(bindings);
            seen.add("action");
            return "saved";
          },
          loader: async ({ bindings }) => {
            assertBindings(bindings);
            seen.add("loader");
            return bindings.KV.get("title");
          },
          head: ({ bindings }) => {
            assertBindings(bindings);
            seen.add("head");
            return { title: bindings.RUNTIME_NAME };
          },
          resources: ({ bindings }) => {
            assertBindings(bindings);
            seen.add("resources");
            return [{ rel: "stylesheet", href: `/${bindings.RUNTIME_NAME}.css` }];
          },
          headers: ({ bindings }) => {
            assertBindings(bindings);
            seen.add("headers");
            return { "x-runtime": bindings.RUNTIME_NAME };
          },
          cache: ({ bindings }) => {
            assertBindings(bindings);
            seen.add("cache");
            return { mode: "private", tags: [bindings.RUNTIME_NAME] };
          },
          render: ({ bindings, data, actionResult }) => {
            assertBindings(bindings);
            seen.add("render");
            return `<h1>${data}:${actionResult}</h1>`;
          },
        },
      ],
    });
    const bindings: Bindings = {
      RUNTIME_NAME: "edge",
      KV: { get: async () => "KV title" },
      DB: { prepare: (query) => ({ query }) },
    };

    const response = await handler.fetch(new Request("https://example.com/", { method: "POST" }), bindings);

    expect(await response.text()).toBe("<h1>KV title:saved</h1>");
    expect(response.headers.get("x-runtime")).toBe("edge");
    expect(response.headers.get("cache-control")).toBe("private");
    expect(seen).toEqual(
      new Set(["middleware", "action", "loader", "render", "head", "headers", "cache", "resources"]),
    );
  });

  it("falls through to dynamic routes when Cloudflare asset basePath does not match", async () => {
    const assetFetch = vi.fn(() => new Response("asset"));
    let routeAssetsBinding: { fetch: typeof assetFetch } | undefined;
    const handler = createWorkersHandler<{ ASSETS: { fetch: typeof assetFetch } }>({
      routes: [
        {
          path: "/",
          render: ({ bindings }) => {
            routeAssetsBinding = bindings.ASSETS;
            return "<h1>Home</h1>";
          },
        },
      ],
      assets: { bindingName: "ASSETS", basePath: "/assets" },
    });
    const assets = { fetch: assetFetch };

    const response = await handler.fetch(new Request("https://example.com/"), { ASSETS: assets });

    expect(assetFetch).not.toHaveBeenCalled();
    expect(routeAssetsBinding).toBe(assets);
    expect(await response.text()).toBe("<h1>Home</h1>");
  });

  it("applies security headers to rejected Cloudflare asset methods", async () => {
    const assetFetch = vi.fn(() => new Response("asset"));
    const handler = createWorkersHandler<{ ASSETS: { fetch: typeof assetFetch } }>({
      routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
      assets: { bindingName: "ASSETS", basePath: "/assets" },
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
    });

    const response = await handler.fetch(new Request("https://example.com/assets/app.js", { method: "POST" }), {
      ASSETS: { fetch: assetFetch },
    });

    expect(assetFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-security-policy")).toContain("'nonce-asset-nonce'");
  });

  it("applies method guards and security headers to static assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-adapter-assets-"));
    try {
      await writeFile(path.join(dir, "app.js"), `console.log("ok");`);
      const handler = createWorkersHandler({
        routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
        assets: { binding: { fetch: () => new Response("unused") }, basePath: "/unmatched" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
      });

      const getResponse = await handler.fetch(new Request("https://example.com/assets/app.js"));
      expect(getResponse.status).toBe(404);

      const makeRequest = (method: string) => {
        const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
          method: string;
          url: string;
          headers: Record<string, string>;
        };
        req.method = method;
        req.url = "/assets/app.js";
        req.headers = { host: "example.com" };
        return req;
      };
      const nodeHandler = createNodeHandler({
        routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
        staticAssets: { rootDir: dir, basePath: "/assets" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
      });
      const getChunks: string[] = [];
      const getHeaders = new Map<string, string | number | readonly string[]>();
      const getRes = {
        statusCode: 200,
        setHeader: vi.fn((key: string, value: string | number | readonly string[]) => {
          getHeaders.set(key, value);
        }),
        end: vi.fn((chunk?: string) => {
          if (chunk) {
            getChunks.push(chunk);
          }
        }),
      };

      await nodeHandler(makeRequest("GET") as never, getRes as never);

      expect(getRes.statusCode).toBe(200);
      expect(getHeaders.get("content-security-policy")).toContain("'nonce-asset-nonce'");
      expect(getChunks.join("")).toBe(`console.log("ok");`);

      const postHeaders = new Map<string, string | number | readonly string[]>();
      const postRes = {
        statusCode: 200,
        setHeader: vi.fn((key: string, value: string | number | readonly string[]) => {
          postHeaders.set(key, value);
        }),
        end: vi.fn(),
      };

      await nodeHandler(makeRequest("POST") as never, postRes as never);

      expect(postRes.statusCode).toBe(405);
      expect(postHeaders.get("allow")).toBe("GET, HEAD");
      expect(postHeaders.get("content-security-policy")).toContain("'nonce-asset-nonce'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns not found for malformed static asset percent encoding", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-adapter-assets-"));
    try {
      const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
        method: string;
        url: string;
        headers: Record<string, string>;
      };
      req.method = "GET";
      req.url = "/assets/%E0%A4%A";
      req.headers = { host: "example.com" };
      const chunks: string[] = [];
      const headers = new Map<string, string | number | readonly string[]>();
      const res = {
        statusCode: 200,
        setHeader: vi.fn((key: string, value: string | number | readonly string[]) => {
          headers.set(key, value);
        }),
        end: vi.fn((chunk?: string) => {
          if (chunk) {
            chunks.push(chunk);
          }
        }),
      };

      await createNodeHandler({
        routes: [{ path: "/", render: () => "<h1>Home</h1>" }],
        staticAssets: { rootDir: dir, basePath: "/assets" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "asset-nonce" }),
      })(req as never, res as never);

      expect(res.statusCode).toBe(404);
      expect(headers.get("content-security-policy")).toContain("'nonce-asset-nonce'");
      expect(chunks.join("")).toBe("Not Found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects encoded static asset path traversal before the dynamic fetch handler", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachyon-adapter-assets-"));
    const outside = await mkdtemp(path.join(tmpdir(), "tachyon-adapter-outside-"));
    try {
      await writeFile(path.join(root, "app.js"), `console.log("asset");`);
      await writeFile(path.join(root, ".env"), "secret");
      await mkdir(path.join(root, ".git"), { recursive: true });
      await writeFile(path.join(root, ".git", "config"), "git-secret");
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
      await symlink(path.join(root, ".env"), path.join(root, "settings.txt"));
      await symlink(path.join(root, ".git"), path.join(root, "metadata"));
      let fetchCalls = 0;
      const handler = createNodeFetchHandler({
        staticAssets: { rootDir: root, basePath: "/assets" },
        fetch: () => {
          fetchCalls += 1;
          return new Response("dynamic");
        },
      });
      const makeRequest = (url: string) => {
        const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
          method: string;
          url: string;
          headers: Record<string, string>;
        };
        req.method = "GET";
        req.url = url;
        req.headers = { host: "example.com" };
        return req;
      };

      for (const url of [
        "/assets/%2e%2e/secret.txt",
        "/assets/%2e%2e%2fsecret.txt",
        "/assets%2f%2e%2e%2fsecret.txt",
        "/assets/..\\secret.txt",
        "/assets/%2e%2e%5csecret.txt",
        "/assets%5c%2e%2e%5csecret.txt",
        "/assets/.env",
        "/assets/.well-known/security.txt",
        "/assets/linked.txt",
        "/assets/settings.txt",
        "/assets/metadata/config",
      ]) {
        const chunks: string[] = [];
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          end: vi.fn((chunk?: string) => {
            if (chunk) {
              chunks.push(chunk);
            }
          }),
        };

        await handler(makeRequest(url) as never, res as never);

        expect(res.statusCode, url).toBe(403);
        expect(chunks.join(""), url).toBe("Forbidden");
      }
      expect(fetchCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects untrusted Node fetch Host before encoded static asset traversal checks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-adapter-assets-"));
    try {
      let fetchCalls = 0;
      const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
        method: string;
        url: string;
        headers: Record<string, string>;
      };
      req.method = "GET";
      req.url = "/assets/%2e%2e/secret.txt";
      req.headers = { host: "evil.example" };
      const chunks: string[] = [];
      const res = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: vi.fn((chunk?: string) => {
          if (chunk) {
            chunks.push(chunk);
          }
        }),
      };

      await createNodeFetchHandler({
        trustedHosts: ["app.example"],
        staticAssets: { rootDir: dir, basePath: "/assets" },
        fetch: () => {
          fetchCalls += 1;
          return new Response("dynamic");
        },
      })(req as never, res as never);

      expect(res.statusCode).toBe(400);
      expect(chunks.join("")).toBe("Untrusted Host header");
      expect(fetchCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pipes Node streaming responses without buffering through end text", async () => {
    const routes: RouteDefinition[] = [
      { path: "/", fallback: "<p>Loading</p>", loader: async () => "Ready", render: ({ data }) => `<h1>${data}</h1>` },
    ];
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      write: vi.fn((chunk: Buffer | string) => {
        chunks.push(String(chunk));
      }),
      end: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === "finish") {
          callback();
        }
      }),
      emit: vi.fn(),
    };

    await createNodeHandler({ routes, streaming: true })(req as never, res as never);

    expect(res.write).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledWith();
    expect(chunks.join("")).toBe("<h1>Ready</h1>");
  });

  it("creates a Node fetch handler that serves static assets before a standards fetch handler", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-fetch-assets-"));
    try {
      await writeFile(path.join(dir, "app.js"), `console.log("asset");`);
      let fetchCalls = 0;
      const handler = createNodeFetchHandler({
        fetch: async (request) => {
          fetchCalls += 1;
          return new Response(`<h1>${new URL(request.url).pathname}</h1>`, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
        staticAssets: { rootDir: dir, basePath: "/assets" },
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "fetch-nonce" }),
      });
      const makeRequest = (url: string) => {
        const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
          method: string;
          url: string;
          headers: Record<string, string>;
        };
        req.method = "GET";
        req.url = url;
        req.headers = { host: "example.com" };
        return req;
      };
      const writeResponse = async (url: string) => {
        const chunks: string[] = [];
        const headers = new Map<string, string | number | readonly string[]>();
        const res = {
          statusCode: 200,
          setHeader: (key: string, value: string | number | readonly string[]) => {
            headers.set(key, value);
          },
          end: (chunk?: string) => {
            if (chunk) {
              chunks.push(chunk);
            }
          },
        };
        await handler(makeRequest(url) as never, res as never);
        return { chunks, headers, res };
      };

      const asset = await writeResponse("/assets/app.js");
      const app = await writeResponse("/dashboard");

      expect(fetchCalls).toBe(1);
      expect(asset.res.statusCode).toBe(200);
      expect(asset.headers.get("content-security-policy")).toContain("'nonce-fetch-nonce'");
      expect(asset.chunks.join("")).toBe(`console.log("asset");`);
      expect(app.res.statusCode).toBe(200);
      expect(app.headers.get("content-security-policy")).toContain("'nonce-fetch-nonce'");
      expect(app.chunks.join("")).toBe("<h1>/dashboard</h1>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls through to a Node fetch handler when root static assets are not found", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachyon-fetch-assets-"));
    try {
      await writeFile(path.join(dir, "app.js"), `console.log("asset");`);
      let fetchCalls = 0;
      const handler = createNodeFetchHandler({
        fetch: async (request) => {
          fetchCalls += 1;
          return new Response(`<h1>${new URL(request.url).pathname}</h1>`, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
        staticAssets: { rootDir: dir, basePath: "/", fallthroughOnNotFound: true },
      });
      const makeRequest = (url: string, method = "GET") => {
        const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
          method: string;
          url: string;
          headers: Record<string, string>;
        };
        req.method = method;
        req.url = url;
        req.headers = { host: "example.com" };
        return req;
      };
      const writeResponse = async (url: string, method = "GET") => {
        const chunks: string[] = [];
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          end: vi.fn((chunk?: string) => {
            if (chunk) {
              chunks.push(chunk);
            }
          }),
        };
        await handler(makeRequest(url, method) as never, res as never);
        return { chunks, res };
      };

      const healthz = await writeResponse("/healthz");
      const home = await writeResponse("/");
      const asset = await writeResponse("/app.js");
      const login = await writeResponse("/login", "POST");

      expect(fetchCalls).toBe(3);
      expect(healthz.res.statusCode).toBe(200);
      expect(healthz.chunks.join("")).toBe("<h1>/healthz</h1>");
      expect(home.res.statusCode).toBe(200);
      expect(home.chunks.join("")).toBe("<h1>/</h1>");
      expect(asset.res.statusCode).toBe(200);
      expect(asset.chunks.join("")).toBe(`console.log("asset");`);
      expect(login.res.statusCode).toBe(200);
      expect(login.chunks.join("")).toBe("<h1>/login</h1>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves static Node routes before a standards fetch handler", async () => {
    let fetchCalls = 0;
    const handler = createNodeFetchHandler({
      fetch: () => {
        fetchCalls += 1;
        return new Response("<h1>Dynamic</h1>");
      },
      staticRoutes: [{ path: "/", body: "<h1>Static</h1>" }],
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "static-fetch-nonce" }),
    });
    const req = Readable.from([]) as unknown as NodeJS.ReadableStream & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "example.com" };
    const chunks: string[] = [];
    const headers = new Map<string, string | number | readonly string[]>();
    const res = {
      statusCode: 200,
      setHeader: (key: string, value: string | number | readonly string[]) => {
        headers.set(key, value);
      },
      end: (chunk?: string) => {
        if (chunk) {
          chunks.push(chunk);
        }
      },
    };

    await handler(req as never, res as never);

    expect(fetchCalls).toBe(0);
    expect(res.statusCode).toBe(200);
    expect(headers.get("content-security-policy")).toContain("'nonce-static-fetch-nonce'");
    expect(headers.get("content-length")).toBe("15");
    expect(chunks.join("")).toBe("<h1>Static</h1>");
  });

  it("converts Lambda HTTP API v2 events into Web requests", async () => {
    const request = requestFromLambdaEvent(
      lambdaEvent({
        rawPath: "/submit",
        rawQueryString: "debug=1",
        cookies: ["session=abc", "theme=dark"],
        headers: { "content-type": "text/plain", host: "client.example" },
        requestContext: {
          domainName: "public.example",
          http: {
            method: "POST",
            path: "/submit",
            protocol: "HTTP/1.1",
            sourceIp: "127.0.0.1",
            userAgent: "vitest",
          },
        },
        body: "hello",
      }),
    );

    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://public.example/submit?debug=1");
    expect(request.headers.get("cookie")).toBe("session=abc; theme=dark");
    expect(request.headers.get("content-type")).toBe("text/plain");
    expect(await request.text()).toBe("hello");
  });

  it("creates a Lambda handler that returns buffered SSR responses with security headers", async () => {
    const handler = createLambdaHandler({
      routes: [{ path: "/", render: () => "<h1>Lambda</h1>" }],
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "lambda-nonce" }),
    });

    const response = await handler(lambdaEvent());

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["content-security-policy"]).toContain("'nonce-lambda-nonce'");
    expect(response.isBase64Encoded).toBe(false);
    expect(response.body).toBe("<h1>Lambda</h1>");
  });

  it("creates a Lambda fetch handler that adapts HTTP API events without route definitions", async () => {
    let seenRequest: Request | undefined;
    const handler = createLambdaFetchHandler({
      origin: "admin.example",
      fetch: async (request) => {
        seenRequest = request;
        return new Response(`<h1>${new URL(request.url).pathname}</h1>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
      securityHeaders: createSecurityHeaders({ csp: true, nonce: "lambda-fetch-nonce" }),
    });

    const response = await handler(
      lambdaEvent({
        rawPath: "/admin",
        rawQueryString: "debug=1",
      }),
    );

    expect(seenRequest?.url).toBe("https://admin.example/admin?debug=1");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("'nonce-lambda-fetch-nonce'");
    expect(response.body).toBe("<h1>/admin</h1>");
  });

  it("maps Set-Cookie headers to Lambda cookies and base64 encodes binary responses", async () => {
    const cookieResponse = await lambdaResponseFromWebResponse(
      new Response("ok", {
        status: 201,
        headers: [
          ["content-type", "text/plain; charset=utf-8"],
          ["set-cookie", "sid=abc; Path=/; HttpOnly"],
          ["x-test", "yes"],
        ],
      }),
    );

    expect(cookieResponse.statusCode).toBe(201);
    expect(cookieResponse.headers["x-test"]).toBe("yes");
    expect(cookieResponse.headers["set-cookie"]).toBeUndefined();
    expect(cookieResponse.cookies).toEqual(["sid=abc; Path=/; HttpOnly"]);
    expect(cookieResponse.body).toBe("ok");
    expect(cookieResponse.isBase64Encoded).toBe(false);

    const bytes = Uint8Array.from([0, 255, 1]);
    const binaryResponse = await lambdaResponseFromWebResponse(
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
    );

    expect(binaryResponse.isBase64Encoded).toBe(true);
    expect(binaryResponse.body).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("base64 encodes Lambda responses that already have content encoding", async () => {
    const bytes = Uint8Array.from([31, 139, 8, 0]);
    const response = await lambdaResponseFromWebResponse(
      new Response(bytes, {
        headers: {
          "content-encoding": "gzip",
          "content-type": "text/html; charset=utf-8",
        },
      }),
    );

    expect(response.isBase64Encoded).toBe(true);
    expect(response.body).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("streams Lambda responses through authoritative awslambda metadata and chunk writes", async () => {
    const chunks: string[] = [];
    const from = vi.fn((stream: Writable) => stream);
    const runtime = {
      streamifyResponse: vi.fn((handler) => handler),
      HttpResponseStream: { from },
    };
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        callback();
      },
    });
    const end = vi.spyOn(stream, "end");
    const handler = createLambdaStreamingHandler(
      {
        routes: [
          {
            path: "/",
            fallback: "<p>Loading</p>",
            loader: async () => "Ready",
            render: ({ data }) => `<h1>${data}</h1>`,
          },
        ],
        streaming: true,
        securityHeaders: createSecurityHeaders({ csp: true, nonce: "stream-nonce" }),
      },
      runtime,
    ) as (event: ReturnType<typeof lambdaEvent>, responseStream: typeof stream, context: unknown) => Promise<void>;

    await handler(lambdaEvent(), stream, {});

    expect(runtime.streamifyResponse).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith(
      stream,
      expect.objectContaining({
        statusCode: 200,
        headers: expect.objectContaining({
          "content-security-policy": expect.stringContaining("'nonce-stream-nonce'"),
          "content-type": "text/html; charset=utf-8",
        }),
      }),
    );
    expect(chunks.join("")).toBe("<h1>Ready</h1>");
    expect(end).toHaveBeenCalledOnce();
  });

  it("commits authoritative headers and delayed CSRF status in Lambda streaming metadata", async () => {
    const from = vi.fn((stream: Writable) => stream);
    const runtime = {
      streamifyResponse: vi.fn((handler) => handler),
      HttpResponseStream: { from },
    };
    const chunks: string[] = [];
    const responseStream = () =>
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk).toString("utf8"));
          callback();
        },
      });
    const action = vi.fn(() => "saved");
    const handler = createLambdaStreamingHandler(
      {
        routes: [
          {
            path: "/account",
            fallback: "secret fallback",
            loader: async () => {
              await delay(10);
              return "private account";
            },
            action,
            cache: { mode: "no-store" },
            headers: () => {
              const headers = new Headers({
                "content-security-policy": "default-src 'self'",
                vary: "Cookie, Accept-Encoding",
              });
              headers.append("set-cookie", "sid=updated; Path=/; HttpOnly");
              headers.append("set-cookie", "theme=dark; Path=/");
              return headers;
            },
            render: ({ data }) => `<h1>${data}</h1>`,
          },
        ],
        streaming: true,
        csrf: {
          verify: async () => {
            await delay(10);
            return false;
          },
        },
      },
      runtime,
    ) as (event: ReturnType<typeof lambdaEvent>, responseStream: Writable, context: unknown) => Promise<void>;

    await handler(
      lambdaEvent({
        rawPath: "/account",
        requestContext: { domainName: "lambda.example", http: { method: "GET", path: "/account" } },
      }),
      responseStream(),
      {},
    );
    expect(from).toHaveBeenLastCalledWith(
      expect.any(Writable),
      expect.objectContaining({
        statusCode: 200,
        headers: expect.objectContaining({
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'",
          vary: "Cookie, Accept-Encoding",
        }),
        multiValueHeaders: { "Set-Cookie": ["sid=updated; Path=/; HttpOnly", "theme=dark; Path=/"] },
      }),
    );
    expect(chunks.join("")).toBe("<h1>private account</h1>");

    chunks.length = 0;
    await handler(
      lambdaEvent({
        rawPath: "/account",
        requestContext: { domainName: "lambda.example", http: { method: "POST", path: "/account" } },
      }),
      responseStream(),
      {},
    );
    expect(from).toHaveBeenLastCalledWith(expect.any(Writable), expect.objectContaining({ statusCode: 403 }));
    expect(chunks.join("")).toBe("<h1>Forbidden</h1>");
    expect(action).not.toHaveBeenCalled();
  });

  it("uses standard Writable backpressure for Lambda response streams", async () => {
    let sourcePulls = 0;
    let releaseFirstWrite: (() => void) | undefined;
    let receivedChunks = 0;
    const chunk = new Uint8Array(32 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sourcePulls += 1;
        controller.enqueue(chunk);
        if (sourcePulls === 128) controller.close();
      },
    });
    let firstWrite = true;
    const stream = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        receivedChunks += 1;
        if (firstWrite) {
          firstWrite = false;
          releaseFirstWrite = callback;
          return;
        }
        callback();
      },
    });

    let settled = false;
    const pending = writeWebResponseToLambdaStream(new Response(body), stream, {
      HttpResponseStream: { from: (value) => value },
    }).then(() => {
      settled = true;
    });
    await delay(10);

    expect(sourcePulls).toBeLessThan(128);
    expect(settled).toBe(false);
    releaseFirstWrite?.();
    await pending;
    expect(receivedChunks).toBe(128);
  });

  it("cancels the Lambda Web source when the Writable pipeline fails", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("destination failed"));
      },
    });

    await expect(
      writeWebResponseToLambdaStream(new Response(body), stream, { HttpResponseStream: { from: (value) => value } }),
    ).rejects.toThrow("destination failed");
    expect(cancelled).toBe(true);
  });

  it("keeps the Workers entry and router runtime free of top-level Node imports", async () => {
    const workersSource = await readFile(path.join(process.cwd(), "src", "adapters", "workers.ts"), "utf8");
    const routerSource = await readFile(path.join(process.cwd(), "src", "router.ts"), "utf8");
    const topLevelNodeImport = /^import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']node:/m;

    expect(workersSource).not.toMatch(topLevelNodeImport);
    expect(routerSource).not.toMatch(topLevelNodeImport);
    expect(routerSource).not.toContain("node:");
  });
});
