# Runtime Modules

Tachyon DOM runtime modules are split so compiler output imports only what it uses.

- `runtime/text`: text node lookup and updates.
- `runtime/class`: element lookup and class toggles.
- `runtime/attr`: dynamic attributes, styles, and refs.
- `runtime/form`: `bind:value`, `bind:checked`, validation, and progressive form helpers.
- `runtime/enhancement`: small progressive enhancement registry for SSR markup that opts in with `data-td-enhance`.
- `runtime/event`: delegated event binding.
- `runtime/list`: keyed list mounting, reuse, move, multi-root item support, and row-scoped binding effects that avoid re-reading unchanged rows after a single row signal changes.
- `runtime/keyed-rows`: dependency-free keyed table-row list where the live DOM is the single source of truth (no shadow item/row arrays). Bulk creation binds and clones a reusable multi-row chunk; remove/swap/select are O(1) DOM operations. Suited to large data tables that do not need per-row reactivity.
- `runtime/virtual-list`: fixed-height virtualized lists with overscan, imperative updates, index scrolling, and ARIA position metadata.
- `runtime/conditional`: conditional DOM mounting.
- `runtime/hydrate`: SSR boundary location, state handoff, hydration scheduling, and dev diagnostics.
- `runtime/router`: client-side navigation with link interception, History API, abortable loaders, scroll hooks, history-entry scroll restoration, focus restoration, optional view transitions, and route HMR cache invalidation.
- `runtime/fragment`: wrapper-free fragment mounting.
- `runtime/portal`: external target mounting.
- `runtime/store` and `runtime/signal`: fine-grained store/signal helpers, memoized computed accessors, async resources, and recoverable effect errors.
- `runtime/stream-client`: browser stream chunk reading.
- `runtime/error-boundary`: DOM-mounted client fallback boundaries.

`runtime/keyed-rows` rejects invalid numeric controls before changing the DOM. `chunks`, generated-row `count`, and update `stride` must be positive finite integers. Zero, negative values, fractions, `NaN`, and infinities throw a `TypeError` that names the invalid parameter. Empty arrays remain valid for `replace([])` and `append([])` because those methods do not accept a generated-row count.

Related public utility subpaths:

- `tachyon-dom/typed`: `defineTemplate()`, `templateScope()`, and `TypedTemplate<Scope>` for carrying template scope types through application code.
- `tachyon-dom/env`: `defineEnvSchema()` and `readEnv()` for runtime environment validation with an explicit full-env/public-env split.
- `tachyon-dom/i18n`: `createI18n()` and `localeMiddleware()` for dictionary lookup and request locale selection.

```ts
import { defineEnvSchema, readEnv } from "tachyon-dom/env";
import { defineTemplate, templateScope, type TypedTemplate } from "tachyon-dom/typed";

type Scope = { title: string };

const template = defineTemplate<Scope, "<h1>{title}</h1>">("<h1>{title}</h1>");
const scoped = templateScope<Scope>().define("<p>{title}</p>");
const typed: TypedTemplate<Scope> = template;

const env = readEnv(
  process.env,
  defineEnvSchema({
    PUBLIC_APP_NAME: { default: "Tachyon App", public: true },
    SESSION_SECRET: { required: true },
  }),
);
if (!env.ok) {
  throw new Error(env.error.map((error) => error.message).join("\n"));
}

void scoped;
void typed;
void env.value.publicEnv.PUBLIC_APP_NAME;
void env.value.env.SESSION_SECRET;
```

## Hydration Strategies

`scheduleHydration(handle, options)` supports:

- `load`
- `idle`
- `visible`
- `media`
- `interaction`

The compiler records hydration boundaries with `hydrate:id={id}`. Runtime scheduling chooses when to call `handle.hydrate()`.

`scheduleHydrationBoundaries(root, boundaries, bind, options)` consumes compiled hydration metadata, creates each boundary handle, and schedules it according to the boundary strategy. Static auto-generated ids can be scheduled directly. Expression-based ids can be resolved with `options.resolveId(boundary)`.

`diagnoseHydrationBoundaries(root, expectedIds)` reports missing, duplicate, or empty boundary markers so SSR/client mismatches can fail loudly in tests and development builds.

## Progressive Forms

`enhanceForm(form, options)` intercepts submit events only when JavaScript is running, builds a `Request` from the existing form markup, and calls `fetch()` or a custom `submit()` callback. Without JavaScript, the same form remains a normal browser form.

`enhanceForm()` also supports:

- `validate(context)` returning `FormValidationResult`.
- `onInvalid(context)`, `onSuccess(context)`, and `onError(context)` lifecycle callbacks.
- `navigate(href, { replace })` for redirect responses.

`validateFormData(formData, rules)` validates field-level `required`, `pattern`, `minLength`, `maxLength`, and custom `validate()` rules. Failed validations set browser custom validity messages and `aria-invalid` on named controls.

## Progressive Enhancements

`runtime/enhancement` is for server-rendered pages that need small client-side behavior without hydrating a whole component tree. Register an initializer by name, mark SSR markup with `data-td-enhance`, and call `enhance()` after the page loads or after inserting markup.

```ts
import { enhance, registerEnhancement } from "tachyon-dom/runtime/enhancement";

registerEnhancement("password-toggle", (root) => {
  const input = root.querySelector("input");
  const button = root.querySelector("button");
  if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) {
    return;
  }
  const listener = () => {
    input.type = input.type === "password" ? "text" : "password";
  };
  button.addEventListener("click", listener);
  return () => button.removeEventListener("click", listener);
});

enhance(document);
```

Each enhancement runs once per element/name pair. A single element can opt into multiple enhancements with a space-separated `data-td-enhance` value. Use `cleanupEnhancements(root)` before removing dynamically replaced markup when initializers attach long-lived listeners or resources.

## Server HTML and Form Actions

`tachyon-dom/server/html` provides a dependency-free SSR string helper. `html` escapes text interpolation by default, escapes direct interpolation after an attribute assignment, and only renders trusted markup through `rawHtml()`. Use `attr()`, `booleanAttr()`, `classList()`, and `join()` for optional attributes, boolean attributes, class composition, and lists.

```ts
import { attr, booleanAttr, html, rawHtml } from "tachyon-dom/server/html";

const fieldId = "email";
const view = html`<label for=${fieldId}>${"Email"}</label>
  <input${attr("id", fieldId)}${attr("name", "email")}${booleanAttr("required", true)}>
    ${rawHtml("<!-- trusted framework output only -->")}</input${attr("id", fieldId)}${attr(
      "name",
      "email",
    )}${booleanAttr("required", true)}
  >`;
```

This helper escapes values; it is not an arbitrary HTML sanitizer. Do not pass user-generated HTML to `rawHtml()`. For untrusted HTML, sanitize before rendering and keep the sanitizer choice explicit at the application boundary.

`tachyon-dom/server/form-action` provides a small SSR form round-trip convention. `formAction()` parses `Request.formData()`, routes success and error branches, and keeps the validation library choice in userland. `preserveFormValues()` preserves submitted values while excluding common password fields by default. `formField()` returns stable input attributes and accessible error markup with `aria-invalid`, `aria-describedby`, and a deterministic error id. `redirectResponse()` accepts path-relative redirects by default; external redirects require `allowExternal: true` and an explicit `allowedOrigins` entry.

`formAction()` is a low-level `Request -> Response` helper. When you call it directly, enforce the accepted HTTP methods and your CSRF/Origin policy before invoking the returned handler. Route actions rendered through `renderRoute()` can use the router-level `csrf` option; direct `formAction()` handlers do not add that protection automatically.

```ts
import { err, ok } from "tachyon-dom";
import { formAction, formField, formState, preserveFormValues, redirectResponse } from "tachyon-dom/server/form-action";
import { html } from "tachyon-dom/server/html";

export const loginAction = formAction({
  parse: async (formData) => {
    const email = String(formData.get("email") ?? "");
    if (!email.includes("@")) {
      return err(
        formState({
          values: preserveFormValues(formData),
          fieldErrors: { email: "Enter a valid email address." },
          formError: "Sign in could not continue.",
        }),
      );
    }
    return ok({ email });
  },
  onSuccess: () => redirectResponse("/dashboard"),
  onError: ({ error }) => {
    const email = formField(error, "email", { id: "login-email" });
    return new Response(String(html`<input${email.inputAttrs()}>${email.error()}</input${email.inputAttrs()}>`), {
      status: 422,
    });
  },
});
```

## Client Router Cache

`createClientRouter()` supports:

- `cache: true` for pathname/search keyed loader caching.
- `initialCache` to seed loader data that was already rendered or embedded by the server.
- `router.prefetch(href)` to warm loader data.
- `router.invalidate(href?)` to clear one cache entry or all cache entries.
- `eager: true` to navigate cache-hit links on `pointerdown`/`mousedown` before the later `click`.
- `liveRegion` to announce navigations.
- `title` to update `document.title` after route render.
- `restoreScroll` for history-entry scroll restoration on `popstate` navigations with a bounded retained-position map.
- `viewTransition` to opt into `document.startViewTransition()` when the browser supports it and reduced motion is not requested.

In-flight prefetches are aborted when their cache entry is invalidated or when the router is disposed.

`createRouteHotReloader()` invalidates the current route cache entry and re-navigates with `replace: true` when a route module update arrives from a dev server.

`connectRouteHotReloader(import.meta.hot, reloader)` wires Vite-style custom HMR events to the route hot reloader. The Vite routes plugin emits `tachyon-dom:routes-update` when a route module changes.

Routes can define `action()` and `revalidateOnAction`. `router.submit(href, init)` calls the matched action, invalidates cache entries according to the policy, and re-renders the current route.

Client action concurrency is latest-operation-wins. A newer submission or navigation aborts the active action, and a stale response cannot revalidate or redirect. Disposing the router also aborts its active action. When `init.signal` is supplied to `router.submit()`, caller cancellation is composed with the router-owned signal rather than replacing it. An action should still observe its signal and stop expensive work promptly.

## Signals

`runtime/signal` provides `createSignal()`, `createMemo()`, `effect()`, `batch()`, `read()`, `untrack()`, `createResource()`, and `catchError()`. Effects run once when registered, then subsequent signal notifications are queued. `batch()` groups multiple writes into one flush, and writes made from inside an active effect are queued until that effect exits so the same effect is not synchronously re-entered. `untrack(fn)` reads signals without subscribing the active effect, and effects created inside `untrack()` are not attached to the active owner. `createMemo()` exposes a cached computed accessor that updates before dependent effects observe the next flush. `createResource()` ties an async loader to a source accessor and exposes `data`, `error`, `loading`, `refetch`, and `dispose`. Accessor changes automatically abort the superseded load and start the next one; only the newest result may update state. The fetcher receives `{ signal }` as its second argument. Call `dispose()` when the resource owner is removed so source tracking detaches and in-flight work is aborted. `catchError()` wraps an effect body with an error callback while keeping the effect subscribed for later successful runs.

## Error Boundaries and i18n

`runtime/error-boundary` provides `createErrorBoundary()` for client enhancements that need a local fallback and reset hook instead of failing the whole mounted region. Plain fallback strings are rendered as text. Intentional markup must use `rawHtml()`; DOM `Node`, `DocumentFragment`, and node arrays are also accepted explicitly.

`tachyon-dom/i18n` provides `createI18n()` for dictionary lookup/interpolation and `localeMiddleware()` for request locale selection from route middleware.

## Deferred Data

`runtime/stream-client` provides:

- `readTextStreamChunks(stream)` to decode a `ReadableStream<Uint8Array>` into text chunks.
- `applyDeferredDataChunk(root, chunk)` to write streamed deferred values into `[data-tachyon-deferred-target="id:key"]` elements.
- `readDeferredDataScriptResult(root, id)` to read server-emitted deferred data scripts while distinguishing missing data from invalid JSON without throwing.
- `readDeferredDataScript(root, id)` as a deprecated compatibility wrapper that returns `undefined` for both missing and invalid data.
