import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeHandler, defineStaticRoute, type RouteDefinition, type StaticRouteDefinition } from "../../../../src/adapters";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, "../../../../dist");

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;");

const items = (prefix, count = 80) =>
  Array.from({ length: count }, (_, index) => `<li>${escapeHtml(prefix)} item ${index + 1}</li>`).join("");

const homeBody = () => `<h1>Home</h1><p>Static route rendered by Tachyon DOM.</p><ul>${items("home")}</ul>`;

const productBody = (id) => {
  const label = `Product ${id}`;
  return `<h1>${escapeHtml(label)}</h1><p>Dynamic route ${escapeHtml(id)}</p><ul>${items(label)}</ul>`;
};

const usersBody = () => `<h1>Dashboard</h1><h2 data-route="users">Users</h2><ul>${items("user", 120)}</ul>`;

const ordersBody = () => `<h1>Dashboard</h1><h2 data-route="orders">Orders</h2><ul>${items("order", 120)}</ul>`;

const ordersNavBody = () => `<h1>Dashboard</h1><h2 data-route="orders">Orders</h2>`;

const streamShell = `<main id="app" data-route="stream"><h1>Stream</h1><p data-stream="shell">Shell</p>`;
const streamBody = () => `<section data-stream="done"><h2>Deferred payload</h2><ul>${items("stream")}</ul></section></main>`;
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const interactiveBody = () => `<h1>Interactive</h1><h2>Counter</h2>
<button data-action="increment" type="button">Increment</button>
<output data-count="0">0</output>
<script>
  {
    const button = document.querySelector('[data-action="increment"]');
    const output = document.querySelector('[data-count]');
    button.addEventListener("click", () => {
      const next = Number(output.getAttribute("data-count")) + 1;
      output.setAttribute("data-count", String(next));
      output.textContent = String(next);
    });
  }
</script>`;

const partial = (route, body) => `<main id="app" data-route="${route}">${body}</main>`;

const seededPartialsFor = (route) => (route === "users" ? [[`${"/dashboard/orders?partial=1"}`, ordersNavBody()]] : []);

const initialCacheFor = (route) => (route === "users" ? [{ href: "/dashboard/orders", data: ordersNavBody() }] : []);

const dashboardClientScript = (route) =>
  route === "users" || route === "orders"
    ? `<script type="module">
      import { createClientRouter } from "/tachyon-dom/runtime/router.js";
      const partialCache = new Map();
      ${JSON.stringify(seededPartialsFor(route))}.forEach(([href, html]) => {
        partialCache.set(new URL(href, location.href).href, html);
      });
      const partialUrl = (href) => {
        const url = new URL(href, location.href);
        url.searchParams.set("partial", "1");
        return url.href;
      };
      const loadPartial = async ({ url, signal }) => {
        const cacheKey = partialUrl(url.href);
        const cached = partialCache.get(cacheKey);
        if (cached) return cached;
        const response = await fetch(cacheKey, { signal });
        const html = await response.text();
        partialCache.set(cacheKey, html);
        return html;
      };
      const dashboardRoute = (path) => ({
        path,
        target: "#app",
        load: loadPartial,
        render: ({ data }) => data,
      });
      const router = createClientRouter({
        root: document.body,
        routes: [dashboardRoute("/dashboard/users"), dashboardRoute("/dashboard/orders")],
        cache: true,
        initialCache: ${JSON.stringify(initialCacheFor(route))},
        eager: true,
        focusSelector: "h1",
      });
      await router.start();
    </script>`
    : "";

const documentShell = (body, route) => `<!doctype html>
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
      <a href="/dashboard/users" data-nav="users" data-prefetch="hover">Users</a>
      <a href="/dashboard/orders" data-nav="orders" data-prefetch="hover">Orders</a>
      <a href="/interactive" data-nav="interactive">Interactive</a>
      <a href="/stream" data-nav="stream">Stream</a>
    </nav>
    <main id="app" data-route="${route}">${body}</main>
    ${dashboardClientScript(route)}
  </body>
</html>`;

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0);
const homeHtml = documentShell(homeBody(), "home");
const usersHtml = documentShell(usersBody(), "users");
const ordersHtml = documentShell(ordersBody(), "orders");
const interactiveHtml = documentShell(interactiveBody(), "interactive");
const usersPartialHtml = usersBody();
const ordersPartialHtml = ordersNavBody();
const route = (path: string, body: string): StaticRouteDefinition => defineStaticRoute({ path, body });
const routes: RouteDefinition[] = [
  {
    path: "/products/:id",
    render: ({ params }) => documentShell(productBody(params.id), "product"),
  },
  {
    path: "/stream",
    fallback: streamShell,
    loader: async () => {
      await delay(20);
      return streamBody();
    },
    render: ({ data }) => data as string,
  },
];
const server = createServer(
  createNodeHandler({
    routes,
    streaming: true,
    staticAssets: { rootDir: distRoot, basePath: "/tachyon-dom/" },
    staticRoutes: [
      route("/", homeHtml),
      route("/dashboard/users", usersHtml),
      route("/dashboard/users?partial=1", usersPartialHtml),
      route("/dashboard/orders", ordersHtml),
      route("/dashboard/orders?partial=1", ordersPartialHtml),
      route("/interactive", interactiveHtml),
    ],
    notFound: () => "Not Found",
  }),
);

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    console.log(`tachyon benchmark listening on http://127.0.0.1:${address.port}`);
  }
});
