import { createServer } from "node:http";

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

const usersBody = () => `<h1>Dashboard</h1><h2>Users</h2><ul>${items("user", 120)}</ul>`;

const ordersBody = () => `<h1>Dashboard</h1><h2>Orders</h2><ul>${items("order", 120)}</ul>`;

const ordersNavBody = () => `<h1>Dashboard</h1><h2>Orders</h2>`;

const streamBody = () =>
  `<h1>Stream</h1><p data-stream="shell">Shell</p><section data-stream="done"><h2>Deferred payload</h2><ul>${items("stream")}</ul></section>`;

const partial = (route, body) => `<main id="app" data-route="${route}">${body}</main>`;

const seededPartialsFor = (route) =>
  route === "users" ? [[`${"/dashboard/orders?partial=1"}`, partial("orders", ordersNavBody())]] : [];

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
      <a href="/dashboard/users" data-nav="users">Users</a>
      <a href="/dashboard/orders" data-nav="orders">Orders</a>
      <a href="/stream" data-nav="stream">Stream</a>
    </nav>
    <main id="app" data-route="${route}">${body}</main>
    <script>
      const partialCache = new Map();
      ${JSON.stringify(seededPartialsFor(route))}.forEach(([href, html]) => {
        partialCache.set(new URL(href, location.href).href, html);
      });
      const partialUrl = (href) => {
        const url = new URL(href, location.href);
        url.searchParams.set("partial", "1");
        return url.href;
      };
      const prefetchPartial = async (href) => {
        const cacheKey = partialUrl(href);
        if (partialCache.has(cacheKey)) return;
        const response = await fetch(cacheKey);
        partialCache.set(cacheKey, await response.text());
      };
      document.querySelectorAll("a[data-nav]").forEach((link) => {
        if (link.pathname.startsWith("/dashboard/")) {
          void prefetchPartial(link.href);
        }
      });
      document.addEventListener("click", async (event) => {
        const link = event.target.closest("a[data-nav]");
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const cacheKey = partialUrl(link.href);
        let html = partialCache.get(cacheKey);
        if (!html) {
          const response = await fetch(cacheKey);
          html = await response.text();
          partialCache.set(cacheKey, html);
        }
        history.pushState(null, "", link.href);
        document.querySelector("#app").outerHTML = html;
      });
      addEventListener("popstate", () => location.reload());
    </script>
  </body>
</html>`;

const html = (response, body) => {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-length", String(Buffer.byteLength(body)));
  response.end(body);
};

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0);
const homeHtml = documentShell(homeBody(), "home");
const product42Html = documentShell(productBody("42"), "product");
const usersHtml = documentShell(usersBody(), "users");
const ordersHtml = documentShell(ordersBody(), "orders");
const usersPartialHtml = partial("users", usersBody());
const ordersPartialHtml = partial("orders", ordersNavBody());
const streamPartialHtml = partial("stream", streamBody());
const streamHtml = partial("stream", streamBody());
const server = createServer((request, response) => {
  if (request.method !== "GET") {
    response.statusCode = 405;
    response.end("Method Not Allowed");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const isPartial = url.searchParams.has("partial");
  if (url.pathname === "/") {
    html(response, homeHtml);
    return;
  }
  if (request.url?.startsWith("/products/42")) {
    html(response, product42Html);
    return;
  }
  if (url.pathname === "/dashboard/users") {
    html(response, isPartial ? usersPartialHtml : usersHtml);
    return;
  }
  if (url.pathname === "/dashboard/orders") {
    html(response, isPartial ? ordersPartialHtml : ordersHtml);
    return;
  }
  if (request.url?.startsWith("/stream")) {
    html(response, isPartial ? streamPartialHtml : streamHtml);
    return;
  }
  response.statusCode = 404;
  response.end("Not Found");
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    console.log(`tachyon benchmark listening on http://127.0.0.1:${address.port}`);
  }
});
