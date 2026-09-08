# App and Vite Integration

`tachyon-dom/app` defines pages once for development HTML, production output, and SSR. `tachyon-dom/vite` compiles `.td` modules and provides app, route, and request-scoped SSR plugins.

## Define an App

```ts
import { defineApp } from "tachyon-dom/app";
import { tachyonApp, tachyonDom } from "tachyon-dom/vite";

export const app = defineApp({
  pages: [
    {
      path: "/",
      fileName: "index.html",
      template: "<section><h1>{title}</h1></section>",
      scope: { title: "Home" },
    },
  ],
});

export default { plugins: [tachyonDom({ reactive: true }), tachyonApp(app)] };
```

`defineApp()` rejects duplicate normalized routes and output filenames before compilation or serving. `/`, `/index.html`, `/guide`, and `/guide/` share normalized route keys. `renderAppDocument()` throws for unknown paths; SSR adapters should use `renderAppResponse()`, whose `{ status, html }` result retains a 404 status for configured or built-in not-found pages.

`pagesFromRouteFiles()` supports route-local conventions and generated registries. The Vite plugin generates development HTML entries and production entries rather than requiring source `index.html` files.

## Template and Document Whitespace

`tachyonDom({ templateWhitespace: "condense" })` condenses formatting whitespace in directly imported templates. Applications compiling raw route source must pass the same policy to `defineApp()` or `loadRouteApp()`. This compiler policy is applied to one shared template tree before client, buffered-server, and streaming-server generation.

When a `.td` module uses `<script setup>`, Vite compiles setup declarations into a factory invoked by each client `bind()` and each server or stream render request. The factory exposes only the declarations and runtime imports whose names appear in the template text, so setup-only helpers stay out of the scope object and the instance store that copies it. Import declarations remain module-scoped. Use a normal `<script>` block for intentionally shared module state.

App document `htmlWhitespace` is a separate tag-syntax policy. Use `"preserve-tags"` or `"normalize-tags"`; it does not condense text-node indentation. See the [whitespace migration guide](migrations/whitespace.md) for compatibility behavior and boundary-specific failures.

## Client Entry on Static Pages

`tachyonApp(app, { clientEntry: "when-required" })` leaves the client entry off pages the compiler proves need no client work: no client binding, hydration boundary, store, component boundary, or `<script setup>`. Such a page then requests no JavaScript at all, and when no page loads the entry the build stops emitting the entry chunk.

The entry is application code, so the plugin cannot see whether it also does work every page needs. An entry that has code of its own is therefore kept on every page and the build reports that it was. Add `clientEntryScope: "pages"` to declare that the entry only mounts or hydrates page modules:

```ts
tachyonApp(app, { appScript: "/src/client/main.ts", clientEntry: "when-required", clientEntryScope: "pages" });
```

The development server has no built chunk to inspect, so it omits the entry only under `clientEntryScope: "pages"`; otherwise it serves the entry as it always did.

## Source Maps

All build commands omit inline source maps by default, including custom modes such as `staging` and `test`, so compiled template source is not embedded in deployment artifacts unintentionally. Development server transforms continue to include inline maps. Set `productionSourceMap: true` to opt a build in.

`sourcemap` has highest precedence: `true` always emits an inline map and `false` always omits it. `productionSourceMap` supplies the build-command default when `sourcemap` is unspecified. `onSourceMap` still receives the map when inline emission is disabled, including with `sourcemap: false`, so an upload hook can publish a private artifact without exposing it in generated code.

## Request Logging

During Vite development, `tachyonDom()` logs request lines such as `GET / 200 4ms`. Query strings are omitted by default. Disable logs with `tachyonDom({ requestLog: false })`, provide `requestLog: { logger }` for a custom sink, or opt into query strings with `requestLog: { includeQuery: true }` only when their disclosure is acceptable.

## Request-Scoped SSR

`tachyonSsr()` mounts a fetch-style `Request -> Response` handler while allowing Vite module and public-asset requests to pass through.

```ts
import { defineConfig } from "vite";
import { attr, html } from "tachyon-dom/server/html";
import { tachyonDom, tachyonSsr } from "tachyon-dom/vite";

const clientScript = (request: Request) =>
  new URL(request.url).searchParams.has("prod") ? "/client/main.js" : "/src/client/main.ts";

export default defineConfig({
  plugins: [
    tachyonDom({ reactive: true }),
    tachyonSsr({
      clientScript,
      fetch: async (request, { clientScript }) => {
        const user = new URL(request.url).searchParams.get("user") ?? "Guest";
        const body = html`<main>Hello ${user}</main>
          <script type="module" ${attr("src", clientScript ?? "")}></script>`;
        return new Response(String(body), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    }),
  ],
});
```

The HTML helper escapes interpolated text and attribute values. It does not sanitize arbitrary HTML; see [Security](security.md).

## Routes and Deployment Packaging

`tachyonDomRoutes()` exposes `virtual:tachyon-dom/routes` with a manifest and lazy dynamic imports, keeping route modules in separate chunks. `packageCloudflarePages()` copies static assets and generates a Pages `_worker.js` that tries `env.ASSETS` before the Tachyon DOM renderer.

For direct runtime deployment behavior, see [Adapters](adapters.md). For loaders, actions, layouts, and client navigation, see [Routing](routing.md).
