import { describe, expect, it, vi } from "vitest";
import { renderRoute, renderRouteStream, type RouteDefinition } from "../src/router";

const collect = async (chunks: AsyncIterable<string>): Promise<string> => {
  let output = "";
  for await (const chunk of chunks) output += chunk;
  return output;
};

const trackedChunks = (...values: string[]) => {
  let index = 0;
  const next = vi.fn(async () =>
    index < values.length
      ? { done: false as const, value: values[index++] as string }
      : { done: true as const, value: undefined },
  );
  const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }));
  const chunks: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next,
      return: returnIterator,
    }),
  };
  return { chunks, next, returnIterator };
};

describe("route document and progressive layout composition", () => {
  it("streams a nested child at the exact legacy outlet with buffered structural parity", async () => {
    const parentRender = vi.fn(({ outlet }: { outlet: string }) => `<main>${outlet}</main>`);
    const observedHeadOutlets: string[] = [];
    const routes: RouteDefinition[] = [
      {
        path: "/",
        render: parentRender,
        head: ({ outlet }) => {
          observedHeadOutlets.push(outlet);
          return { title: "Post" };
        },
        children: [
          {
            path: "post",
            render: () => `<article><h1>Post</h1><p>Done</p></article>`,
            stream: async function* () {
              yield `<article><h1>Post</h1>`;
              yield `<p>Done</p></article>`;
            },
          },
        ],
      },
    ];

    const buffered = await renderRoute(routes, "https://example.test/post");
    const streamed = await renderRouteStream(routes, "https://example.test/post");
    if (!buffered.ok || !streamed.ok) throw new Error("Expected route render success.");
    const iterator = streamed.value.chunks[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "<main>" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "<article><h1>Post</h1>" });
    let joined = "<main><article><h1>Post</h1>";
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      joined += next.value;
    }

    expect(joined).toBe(buffered.value.html);
    expect(parentRender).toHaveBeenCalledTimes(2);
    expect(observedHeadOutlets).toEqual([buffered.value.html.replace(/^<main>|<\/main>$/g, ""), ""]);
  });

  it("preserves every ancestor in a three-level progressive route", async () => {
    const routes: RouteDefinition[] = [
      {
        path: "/",
        render: ({ outlet }) => `<html><body>${outlet}</body></html>`,
        children: [
          {
            path: "docs",
            render: ({ outlet }) => `<main>${outlet}</main>`,
            children: [
              {
                path: ":id",
                render: ({ params }) => `<h1>${params.id}</h1>`,
                stream: async function* ({ params }) {
                  yield `<h1>${params.id}</h1>`;
                },
              },
            ],
          },
        ],
      },
    ];

    const result = await renderRouteStream(routes, "https://example.test/docs/api");
    if (!result.ok) throw new Error(result.error.message);

    expect(await collect(result.value.chunks)).toBe(`<html><body><main><h1>api</h1></main></body></html>`);
  });

  it.each([
    ["zero", () => "<main>fixed</main>"],
    ["many", ({ outlet }: { outlet: string }) => `<main>${outlet}${outlet}</main>`],
    ["transformed", ({ outlet }: { outlet: string }) => `<main>${outlet.toUpperCase()}</main>`],
  ])("rejects an ambiguous legacy %s outlet before pulling the child", async (_case, render) => {
    const tracked = trackedChunks("child");
    const routes: RouteDefinition[] = [
      {
        path: "/",
        render,
        children: [
          {
            path: "child",
            render: () => "buffered",
            stream: () => tracked.chunks,
          },
        ],
      },
    ];

    const result = await renderRouteStream(routes, "https://example.test/child");
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.status).toBe(500);
    expect(await collect(result.value.chunks)).toBe("<h1>Internal Server Error</h1>");
    expect(tracked.next).not.toHaveBeenCalled();
    expect(tracked.returnIterator).toHaveBeenCalledTimes(1);
  });

  it("supports explicit bounded child omission without pulling the child", async () => {
    const tracked = trackedChunks("child");
    const routes: RouteDefinition[] = [
      {
        path: "/",
        render: ({ outlet }) => `<main>${outlet}</main>`,
        streamLayout: () => ({ before: "<main>fixed", after: "</main>", outlet: "omit" }),
        children: [
          {
            path: "child",
            render: () => "buffered",
            stream: () => tracked.chunks,
          },
        ],
      },
    ];

    const result = await renderRouteStream(routes, "https://example.test/child");
    if (!result.ok) throw new Error(result.error.message);

    expect(await collect(result.value.chunks)).toBe("<main>fixed</main>");
    expect(tracked.next).not.toHaveBeenCalled();
    expect(tracked.returnIterator).toHaveBeenCalledTimes(1);
  });

  it.each(["before-first-pull", "after-prefix", "during-child"] as const)(
    "propagates cancellation exactly once at %s",
    async (phase) => {
      const tracked = trackedChunks("first", "second");
      const routes: RouteDefinition[] = [
        {
          path: "/",
          render: ({ outlet }) => `<main>${outlet}</main>`,
          children: [{ path: "child", render: () => "buffered", stream: () => tracked.chunks }],
        },
      ];
      const result = await renderRouteStream(routes, "https://example.test/child");
      if (!result.ok) throw new Error(result.error.message);
      const iterator = result.value.chunks[Symbol.asyncIterator]();

      if (phase !== "before-first-pull") {
        await expect(iterator.next()).resolves.toEqual({ done: false, value: "<main>" });
        expect(tracked.next).not.toHaveBeenCalled();
      }
      if (phase === "during-child") {
        await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
        expect(tracked.next).toHaveBeenCalledTimes(1);
      }
      await iterator.return?.();

      expect(tracked.next).toHaveBeenCalledTimes(phase === "during-child" ? 1 : 0);
      expect(tracked.returnIterator).toHaveBeenCalledTimes(1);
    },
  );
});
