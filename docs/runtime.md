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
- `router.prefetch(href)` to warm loader data.
- `router.invalidate(href?)` to clear one cache entry or all cache entries.
- `liveRegion` to announce navigations.
- `title` to update `document.title` after route render.

`createRouteHotReloader()` invalidates the current route cache entry and re-navigates with `replace: true` when a route module update arrives from a dev server.
