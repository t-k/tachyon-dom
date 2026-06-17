# Runtime Modules

Tachyon DOM runtime modules are split so compiler output imports only what it uses.

- `runtime/text`: text node lookup and updates.
- `runtime/class`: element lookup and class toggles.
- `runtime/attr`: dynamic attributes, styles, and refs.
- `runtime/form`: `bind:value` and `bind:checked` helpers.
- `runtime/event`: delegated event binding.
- `runtime/list`: keyed list mounting, reuse, move, and multi-root item support.
- `runtime/conditional`: conditional DOM mounting.
- `runtime/hydrate`: SSR boundary location, state handoff, and hydration scheduling.
- `runtime/router`: client-side navigation with link interception, History API, abortable loaders, scroll hooks, focus restoration, and route HMR cache invalidation.
- `runtime/fragment`: wrapper-free fragment mounting.
- `runtime/portal`: external target mounting.
- `runtime/store` and `runtime/signal`: fine-grained store/signal helpers.
- `runtime/stream-client`: browser stream chunk reading.

## Hydration Strategies

`scheduleHydration(handle, options)` supports:

- `load`
- `idle`
- `visible`
- `media`
- `interaction`

The compiler records hydration boundaries with `hydrate:id={id}`. Runtime scheduling chooses when to call `handle.hydrate()`.

`diagnoseHydrationBoundaries(root, expectedIds)` reports missing, duplicate, or empty boundary markers so SSR/client mismatches can fail loudly in tests and development builds.

## Progressive Forms

`enhanceForm(form, options)` intercepts submit events only when JavaScript is running, builds a `Request` from the existing form markup, and calls `fetch()` or a custom `submit()` callback. Without JavaScript, the same form remains a normal browser form.

## Client Router Cache

`createClientRouter()` supports:

- `cache: true` for pathname/search keyed loader caching.
- `initialCache` to seed loader data that was already rendered or embedded by the server.
- `router.prefetch(href)` to warm loader data.
- `router.invalidate(href?)` to clear one cache entry or all cache entries.
- `eager: true` to navigate cache-hit links on `pointerdown`/`mousedown` before the later `click`.
- `liveRegion` to announce navigations.
- `title` to update `document.title` after route render.

In-flight prefetches are aborted when their cache entry is invalidated or when the router is disposed.

`createRouteHotReloader()` invalidates the current route cache entry and re-navigates with `replace: true` when a route module update arrives from a dev server.

`connectRouteHotReloader(import.meta.hot, reloader)` wires Vite-style custom HMR events to the route hot reloader. The Vite routes plugin emits `tachyon-dom:routes-update` when a route module changes.

Routes can define `action()` and `revalidateOnAction`. `router.submit(href, init)` calls the matched action, invalidates cache entries according to the policy, and re-renders the current route.

## Signal Roadmap

`runtime/signal` intentionally starts with a small `signal`/`effect` surface. It does not yet include batching or computed memo helpers. Multiple sequential writes can therefore trigger multiple effect runs, and effects should avoid writing back to their own dependencies unless the caller guards against loops. `batch()` and `computed()` are planned extension points rather than current guarantees.

## Deferred Data

`runtime/stream-client` provides:

- `applyDeferredDataChunk(root, chunk)` to write streamed deferred values into `[data-tachyon-deferred-target="id:key"]` elements.
- `readDeferredDataScript(root, id)` to read server-emitted deferred data scripts.
