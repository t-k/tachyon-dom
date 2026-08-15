import { describe, expect, it } from "vitest";
import { createLambdaHandler, createWorkersHandler } from "../src/adapters";
import { enhanceForm } from "../src/runtime/form";
import { diagnoseHydrationBoundaries } from "../src/runtime/hydrate";
import { createClientRouter, rawHtml, type ClientRouteDefinition } from "../src/runtime/router";
import { readTextStreamChunks } from "../src/runtime/stream-client";
import { matchRoute, type RouteDefinition } from "../src/router";

describe("router compatibility matrix", () => {
  it("keeps server and client route matching semantics aligned", async () => {
    const cases = [
      { href: "/users/new", routeId: "new-user", html: "<h1>new-user:{}</h1>" },
      { href: "/users/launch%20notes", routeId: "user", html: `<h1>launch notes</h1>` },
      { href: "/blog/2026/launch%20notes", routeId: "blog", html: `<h1>2026/launch notes</h1>` },
      { href: "/users/42/", routeId: "user", html: `<h1>42</h1>` },
      { href: "/missing", routeId: "fallback", html: `<h1>fallback:{}</h1>` },
    ];
    const serverRoutes: RouteDefinition[] = [
      { id: "user", path: "/users/:id", render: ({ params }) => `<h1>${params.id}</h1>` },
      { id: "new-user", path: "/users/new", render: () => "<h1>new-user:{}</h1>" },
      { id: "blog", path: "/blog/*slug", render: ({ params }) => `<h1>${params.slug}</h1>` },
      { id: "fallback", path: "*", render: () => "<h1>fallback:{}</h1>" },
    ];
    const clientRoutes: ClientRouteDefinition[] = [
      { id: "user", path: "/users/:id", render: ({ params }) => rawHtml(`<h1>${params.id}</h1>`) },
      { id: "new-user", path: "/users/new", render: () => rawHtml("<h1>new-user:{}</h1>") },
      { id: "blog", path: "/blog/*slug", render: ({ params }) => rawHtml(`<h1>${params.slug}</h1>`) },
      { id: "fallback", path: "*", render: () => rawHtml("<h1>fallback:{}</h1>") },
    ];
    document.body.innerHTML = `<main id="app"></main>`;
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing app root.");
    }
    history.replaceState({}, "", "/");
    const router = createClientRouter({ root, routes: clientRoutes, scrollTo: () => undefined });
    await router.start();

    try {
      for (const item of cases) {
        const serverMatch = matchRoute(serverRoutes, `https://example.com${item.href}`);
        expect(serverMatch.ok && serverMatch.value.route.id).toBe(item.routeId);
        await router.navigate(item.href);
        expect(root.innerHTML).toBe(item.html);
      }
    } finally {
      router.dispose();
    }
  });

  it.each([
    { runtime: "workers", streaming: false },
    { runtime: "workers", streaming: true },
  ])("renders routes in $runtime adapter with streaming=$streaming", async ({ streaming }) => {
    const routes: RouteDefinition[] = [
      {
        id: "home",
        path: "/",
        fallback: "<p>Loading</p>",
        loader: async () => ({ title: "Home" }),
        render: ({ data }) => `<h1>${(data as { title: string }).title}</h1>`,
      },
    ];
    const response = await createWorkersHandler({ routes, streaming }).fetch(new Request("https://x.test/"));
    const expected = `<h1>Home</h1><script type="application/json" data-tachyon-state="route:home">{"title":"Home"}</script>`;

    expect(response.status).toBe(200);
    if (streaming && response.body) {
      expect((await readTextStreamChunks(response.body)).join("")).toBe(expected);
    } else {
      await expect(response.text()).resolves.toBe(expected);
    }
  });

  it("omits empty text chunks when UTF-8 characters cross byte boundaries", async () => {
    const encoded = new TextEncoder().encode("€");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 1));
        controller.enqueue(encoded.slice(1));
        controller.close();
      },
    });

    await expect(readTextStreamChunks(stream)).resolves.toEqual(["€"]);
  });

  it("exports the Lambda adapter through the compatibility entry", async () => {
    const handler = createLambdaHandler({
      routes: [{ path: "/", render: () => "<h1>Lambda</h1>" }],
    });

    const response = await handler({
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
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("<h1>Lambda</h1>");
  });

  it("covers SSR hydration diagnostics and progressive form enhancement together", async () => {
    document.body.innerHTML = `
      <main><!--tachyon-hydrate:panel:start--><section></section><!--tachyon-hydrate:panel:end--></main>
      <form action="/save" method="post"><input name="title" value="Hello"></form>
    `;
    expect(diagnoseHydrationBoundaries(document.body, ["panel"])).toEqual([]);
    const form = document.querySelector("form");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Missing form.");
    }
    const submissions: string[] = [];
    const cleanup = enhanceForm(form, {
      submit: async ({ request }) => {
        submissions.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response("ok");
      },
    });

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submissions).toEqual(["POST /save"]);
    cleanup();
  });
});
