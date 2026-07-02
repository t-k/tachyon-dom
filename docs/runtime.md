# Runtime Modules

Tachyon DOM runtime modules are split so compiler output imports only what it uses.

- `runtime/text`: text node lookup and updates.
- `runtime/class`: element lookup and class toggles.
- `runtime/attr`: dynamic attributes, styles, and refs.
- `runtime/form`: `bind:value`, `bind:checked`, validation, and progressive form helpers.
- `runtime/enhancement`: small progressive enhancement registry for SSR markup that opts in with `data-td-enhance`.
- `runtime/event`: delegated event binding.
- `runtime/list`: keyed list mounting, reuse, move, and multi-root item support.
- `runtime/keyed-rows`: dependency-free keyed table-row list where the live DOM is the single source of truth (no shadow item/row arrays). Bulk creation binds and clones a reusable multi-row chunk; remove/swap/select are O(1) DOM operations. Suited to large data tables that do not need per-row reactivity.
- `runtime/virtual-list`: fixed-height virtualized lists with overscan, imperative updates, index scrolling, and ARIA position metadata.
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
  ${rawHtml("<!-- trusted framework output only -->")}`;
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
      return err(formState({
        values: preserveFormValues(formData),
        fieldErrors: { email: "Enter a valid email address." },
        formError: "Sign in could not continue.",
      }));
    }
    return ok({ email });
  },
  onSuccess: () => redirectResponse("/dashboard"),
  onError: ({ error }) => {
    const email = formField(error, "email", { id: "login-email" });
    return new Response(String(html`<input${email.inputAttrs()}>${email.error()}`), { status: 422 });
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

In-flight prefetches are aborted when their cache entry is invalidated or when the router is disposed.

`createRouteHotReloader()` invalidates the current route cache entry and re-navigates with `replace: true` when a route module update arrives from a dev server.

`connectRouteHotReloader(import.meta.hot, reloader)` wires Vite-style custom HMR events to the route hot reloader. The Vite routes plugin emits `tachyon-dom:routes-update` when a route module changes.

Routes can define `action()` and `revalidateOnAction`. `router.submit(href, init)` calls the matched action, invalidates cache entries according to the policy, and re-renders the current route.

## Signals

`runtime/signal` provides `createSignal()`, `createMemo()`, `effect()`, `batch()`, and `read()`. Effects run once when registered, then subsequent signal notifications are queued. `batch()` groups multiple writes into one flush, and writes made from inside an active effect are queued until that effect exits so the same effect is not synchronously re-entered. `createMemo()` exposes a cached computed accessor that updates before dependent effects observe the next flush.

## Deferred Data

`runtime/stream-client` provides:

- `readTextStreamChunks(stream)` to decode a `ReadableStream<Uint8Array>` into text chunks.
- `applyDeferredDataChunk(root, chunk)` to write streamed deferred values into `[data-tachyon-deferred-target="id:key"]` elements.
- `readDeferredDataScript(root, id)` to read server-emitted deferred data scripts.
