import { createWorkersHandler, type WorkersAssetsBinding } from "../../src/adapters/workers";
import { createSecurityHeaders } from "../../src/router";
import { loadTopStories, type HackerNewsError, type HackerNewsStory } from "./hn-api";
import { renderHackerNewsStream } from "./renderer";
import { type Result } from "../../src/result";

export type HackerNewsEnv = {
  ASSETS?: WorkersAssetsBinding;
};

export type HackerNewsWorkerOptions = {
  loadStories?: () => Promise<Result<readonly HackerNewsStory[], HackerNewsError>>;
};

const streamToResponse = (chunks: AsyncIterable<string>, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      },
      async cancel() {
        await iterator.return?.();
      },
    }),
    { ...init, headers },
  );
};

const securityHeaders = createSecurityHeaders({ csp: true });

const mergeHeaders = (response: Response, headers: Headers): Response => {
  const nextHeaders = new Headers(response.headers);
  headers.forEach((value, key) => nextHeaders.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  });
};

const assetsHandler = createWorkersHandler<HackerNewsEnv>({
  assets: { bindingName: "ASSETS", basePath: "/assets" },
  routes: [],
  securityHeaders,
});

export const createHackerNewsWorker = (options: HackerNewsWorkerOptions = {}) => {
  const loadStories = options.loadStories ?? (() => loadTopStories());
  return {
    fetch: async (request: Request, env: HackerNewsEnv): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/assets/")) {
        return assetsHandler.fetch(request, env);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return mergeHeaders(
          new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          }),
          securityHeaders,
        );
      }
      const response = streamToResponse(
        renderHackerNewsStream({
          loadStories,
        }),
      );
      return mergeHeaders(response, securityHeaders);
    },
  };
};

export default createHackerNewsWorker();
