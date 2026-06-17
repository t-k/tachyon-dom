import { createServer } from "node:http";
import { createNodeHandler } from "../../../../src/adapters";
import { type RouteContext, type RouteDefinition } from "../../../../src/router";

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;");

const items = (prefix: string, count = 80): string =>
  Array.from({ length: count }, (_, index) => `<li>${escapeHtml(prefix)} item ${index + 1}</li>`).join("");

const documentShell = (body: string, route: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tachyon Web Framework Benchmark</title>
  </head>
  <body>
    <nav>
      <a href="/" data-nav="home">Home</a>
      <a href="/products/42" data-nav="product">Product</a>
      <a href="/dashboard/users" data-nav="users">Users</a>
      <a href="/dashboard/orders" data-nav="orders">Orders</a>
      <a href="/stream" data-nav="stream">Stream</a>
    </nav>
    <main id="app" data-route="${route}">${body}</main>
    <script>
      document.addEventListener("click", async (event) => {
        const link = event.target.closest("a[data-nav]");
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const response = await fetch(link.href + (link.href.includes("?") ? "&" : "?") + "partial=1");
        const html = await response.text();
        history.pushState(null, "", link.href);
        document.querySelector("#app").outerHTML = html;
      });
      addEventListener("popstate", () => location.reload());
    </script>
  </body>
</html>`;

const page = (context: RouteContext, route: string, body: string): string =>
  context.url.searchParams.has("partial")
    ? `<main id="app" data-route="${route}">${body}</main>`
    : documentShell(body, route);

const routes: RouteDefinition[] = [
  {
    id: "home",
    path: "/",
    render: (context) =>
      page(context, "home", `<h1>Home</h1><p>Static route rendered by Tachyon DOM.</p><ul>${items("home")}</ul>`),
  },
  {
    id: "product",
    path: "/products/:id",
    loader: ({ params }) => ({ id: params.id, label: `Product ${params.id}` }),
    render: (context) => {
      const data = context.data as { id: string; label: string };
      return page(
        context,
        "product",
        `<h1>${escapeHtml(data.label)}</h1><p>Dynamic route ${escapeHtml(data.id)}</p><ul>${items(data.label)}</ul>`,
      );
    },
  },
  {
    id: "users",
    path: "/dashboard/users",
    render: (context) => page(context, "users", `<h1>Dashboard</h1><h2>Users</h2><ul>${items("user", 120)}</ul>`),
  },
  {
    id: "orders",
    path: "/dashboard/orders",
    render: (context) => page(context, "orders", `<h1>Dashboard</h1><h2>Orders</h2><ul>${items("order", 120)}</ul>`),
  },
  {
    id: "stream",
    path: "/stream",
    render: (context) =>
      page(
        context,
        "stream",
        `<h1>Stream</h1><p data-stream="shell">Shell</p><section data-stream="done"><h2>Deferred payload</h2><ul>${items("stream")}</ul></section>`,
      ),
  },
];

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0);
const server = createServer(createNodeHandler({ routes, streaming: true }));

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    console.log(`tachyon benchmark listening on http://127.0.0.1:${address.port}`);
  }
});
