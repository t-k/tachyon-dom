import { renderRoute, type RouteDefinition } from "../src/router";

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
  const result = await renderRoute(routes, "https://example.com/app/users/42");
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value.html + result.value.headHtml + result.value.stateScript;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await renderRouterExample());
}
