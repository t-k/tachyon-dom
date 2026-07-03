import { defineEnvSchema, readEnv } from "../src/env";
import { renderRoute, type RouteDefinition } from "../src/router";

const envSchema = defineEnvSchema({
  PUBLIC_APP_NAME: { default: "Tachyon Router Example", public: true },
});

const routes: RouteDefinition[] = [
  {
    id: "app",
    path: "/app",
    head: () => ({ links: [{ rel: "modulepreload", href: "/app.js" }] }),
    render: ({ outlet }) => `<!doctype html><html><head></head><body><main>${outlet}</main></body></html>`,
    children: [
      {
        id: "user",
        path: "users/:id",
        loader: ({ params }) => ({ name: `User ${params.id}` }),
        head: ({ data }) => ({ title: (data as { name: string }).name }),
        render: ({ data }) => `<h1>${(data as { name: string }).name}</h1>`,
      },
    ],
  },
];

export const renderRouterExample = async (): Promise<string> => {
  const env = readEnv({ PUBLIC_APP_NAME: process.env.PUBLIC_APP_NAME }, envSchema);
  if (!env.ok) {
    throw new Error(env.error.map((error) => error.message).join("\n"));
  }
  const result = await renderRoute(routes, "https://example.com/app/users/42");
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return (
    `<!-- ${env.value.publicEnv.PUBLIC_APP_NAME} -->` +
    result.value.html +
    result.value.headHtml +
    result.value.stateScript
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await renderRouterExample());
}
