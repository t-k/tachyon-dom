import { describe, expect, it } from "vitest";
import { createLambdaHandler, createWorkersHandler } from "../src/adapters";
import { enhanceForm } from "../src/runtime/form";
import { diagnoseHydrationBoundaries } from "../src/runtime/hydrate";
import { readTextStreamChunks } from "../src/runtime/stream-client";
import { type RouteDefinition } from "../src/router";

describe("router compatibility matrix", () => {
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

    expect(response.status).toBe(200);
    if (streaming && response.body) {
      expect((await readTextStreamChunks(response.body)).join("")).toBe("<p>Loading</p><h1>Home</h1>");
    } else {
      await expect(response.text()).resolves.toBe("<h1>Home</h1>");
    }
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
