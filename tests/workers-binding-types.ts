import { createLambdaHandler } from "../src/adapters/lambda";
import { createNodeHandler } from "../src/adapters/node";
import { createWorkersHandler } from "../src/adapters/workers";
import type { RouteDefinition } from "../src/router";

type Bindings = {
  KV: { get: (key: string) => Promise<string> };
};

const request = new Request("https://example.com/");
const workers = createWorkersHandler<Bindings>({
  routes: [
    {
      path: "/",
      loader: ({ bindings }) => bindings.KV.get("title"),
      render: ({ bindings, data }) => `${bindings}:${data}`,
      stream: async function* ({ bindings, data }) {
        yield `${await bindings.KV.get("stream")}:${data}`;
      },
    },
  ],
});

// @ts-expect-error Explicit Workers bindings must be supplied for every invocation.
void workers.fetch(request);
void workers.fetch(request, { KV: { get: async () => "title" } });

const routes: RouteDefinition[] = [
  {
    path: "/",
    render: (context) => {
      // @ts-expect-error Workers bindings are not part of the platform-neutral route context.
      return String(context.bindings);
    },
  },
];

createNodeHandler({
  routes,
  // @ts-expect-error Node handlers do not accept Workers invocation bindings.
  bindings: { KV: {} },
});

createLambdaHandler({
  routes,
  // @ts-expect-error Lambda handlers do not accept Workers invocation bindings.
  bindings: { KV: {} },
});
