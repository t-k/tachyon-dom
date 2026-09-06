# Runtime Modules

Tachyon DOM runtime modules are split so compiler output imports only what it uses.

- `runtime/text`: text node lookup and updates.
- `runtime/class`: element lookup and class toggles.
- `runtime/attr`: dynamic attributes, styles, and refs.
- `runtime/form`: `bind:value`, `bind:checked`, validation, and progressive form helpers.
- `runtime/enhancement`: small progressive enhancement registry for SSR markup that opts in with `data-td-enhance`.
- `runtime/event`: direct event listener binding.
- `runtime/list`: keyed list mounting, reuse, move, multi-root item support, row-local stores/components/hydration boundaries, and precomputed binding plans that avoid rebuilding per-row binding subsets.
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

Browser feature bundles have independent minified and Brotli budgets for `runtime/list`, `runtime/form`, `runtime/conditional`, and `runtime/router`. The current generated-list baselines are 34914 minified/10495 Brotli bytes and 34728 minified/10468 Brotli bytes for conditional bindings; the checks leave a small Brotli variance margin while rejecting compiler, server, TypeScript, parse5, and language-server inputs from the browser graph. Run `pnpm check:browser-feature-budgets` after changing one of these modules.

## Mount and Hydrate Entrypoints

`mount(root, module, scope)` replaces the root contents with trusted compiler output, passes the rendered template's first element to `module.bind()`, and returns a `MountHandle` whose `root` remains the container supplied by the caller. Calling `dispose()` more than once is harmless; it releases the module's resources but intentionally leaves the rendered DOM in place. `module.bind()` may return a cleanup function, and the generated client binding owns its reactive root through the same handle.

`hydrate(root, module, scope)` accepts either the rendered template element itself or a container holding exactly one rendered template element. It validates the template's element structure and static attributes, allows only compiler-declared dynamic attributes, and rejects unsafe extra nodes or inline event attributes before binding. It also validates compiler-declared dynamic list and conditional regions, including SSR rows between static siblings, and validates the module's hydration markers without replacing server-rendered DOM. It returns a `Result`: an `ok` value contains the same idempotent `MountHandle`, while an `err` value contains a hydration diagnostic when the structure or markers do not match. Both functions expect `templateHtml` and binding metadata produced by the compiler or another trusted build step. They do not sanitize arbitrary HTML.

## Reusable Template Components

`createTemplateComponent({ client, scope, render, stream })` separates a reusable component interface from the compiler's transparent `<component>` boundary. Each `mount()` or `hydrate()` call creates an independent reactive scope and returns a `TemplateComponentInstance` with an idempotent `dispose()` and an `update(props)` method. `scope(props)` can map public props to the names consumed by the client module; pass slot content through that scope when using `<slot>`.

```ts
import { createTemplateComponent } from "tachyon-dom";

const card = createTemplateComponent({
  client: { templateHtml: "<article></article>", bind: (root, scope) => {
    root.textContent = String(scope.title);
  } },
  render: (props: { title: string }) => `<article>${props.title}</article>`,
});
const instance = card.mount(document.querySelector("#app")!, { title: "Hello" });
instance.update({ title: "Updated" });
instance.dispose();
```

The renderer is supplied by the application or compiler output and is responsible for escaping or sanitizing any user-controlled values. The component interface does not make arbitrary HTML trusted.

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

## Virtualized Lists

`createVirtualizedList()` renders a fixed-height visible window with overscan. Provide `getKey(item, index)` to preserve row elements across scrolling and `update()` calls. Duplicate keys are rejected before the current window changes. When new objects reuse an existing key, use `updateItem(element, item, index)` to refresh their visible content without replacing the element; omitting it intentionally preserves local DOM state such as an edited input value. Without `getKey`, list identity remains index-based.

## Hydration Strategies

`scheduleHydration(handle, options)` supports:

- `load`
- `idle`
- `visible`
- `media`
- `interaction`

The compiler records hydration boundaries with `hydrate:id={id}`. Runtime scheduling chooses when to call `handle.hydrate()`.

`scheduleHydrationBoundaries(root, boundaries, bind, options)` consumes compiled hydration metadata, creates each boundary handle, and schedules it according to the boundary strategy. Static auto-generated ids can be scheduled directly. Expression-based ids can be resolved with `options.resolveId(boundary)`. Interaction boundaries replay the triggering event by default; pass `replayInteraction: false` when an integration intentionally owns the original event lifecycle.

`createLazyHydrationBoundary(root, id, load, options)` keeps the SSR subtree untouched until hydration is triggered, then loads a boundary chunk once and binds it. Concurrent triggers share the same load promise. A dispose during import prevents the binder from running; a rejected load is reported through `onError` and can be retried. With `replayInteraction: true`, the first interaction is replayed after the asynchronous bind completes without allowing the original event's default action to run twice. The replay is suppressed at the boundary, so capture listeners on ancestors such as `document` still observe both the original interaction and the replayed clone; use `isReplayedInteraction(event)` in those listeners to skip side effects for the replay. The replayed clone is a synthetic event: it is not `isTrusted` and does not carry user activation, so do not place controls that need transient activation (WebAuthn, Payment Request, clipboard writes, `window.open`) inside an interaction boundary. A failed chunk load re-arms the interaction trigger after reporting through `onError`, so the next interaction retries the load. Only cancelable interactions are suppressed and replayed: a non-cancelable event keeps propagating untouched, hydration starts, and no clone is dispatched, so an asynchronously loaded handler is not guaranteed to receive that first interaction; choose an eager or `load` strategy when the first interaction must be handled. `isReplayedInteraction` is a de-duplication aid, never a substitute for authentication, `isTrusted`, or user activation checks. Boundary markers are validated before any binding starts: duplicate or malformed SSR markers make hydration fail instead of binding another element, while rows or branches created on the client without markers bind eagerly. Top-level `<store>` declarations belong to the template instance and are created once by the entry; eager bindings and boundary chunks share that state, so updates made before a boundary loads are visible inside it. The Vite plugin emits one dynamic import per top-level compiler hydration boundary and serves a boundary-only module for that import. The loader is application code and should only import trusted build output. Import `./Page.td?client&hydrate-only` for a module that hydrates server-rendered markup: boundary bindings and the runtime modules only they use are removed from the module at generation time, `bind` is not exported, and `hydrate(root, module, scope)` is the only entrypoint (`mount()` rejects such a module before touching the DOM). The ordinary import keeps every binding so `mount()` stays synchronous. Dependencies used by the SFC setup script or by eager bindings remain in the entry in both forms. Hydrating the same root twice without disposing the first handle returns an error.

`diagnoseHydrationBoundaries(root, expectedIds)` reports missing, duplicate, or empty boundary markers so SSR/client mismatches can fail loudly in tests and development builds.

## Development Runtime Diagnostics

`tachyon-dom/runtime/diagnostics` is an opt-in development entry. `createRuntimeDiagnostics({ bindings, onEvent })` observes aggregate owner, effect, subscription, and cleanup counts, records lifecycle events, and maps a `(templateId, path)` pair to a source location supplied by the compiler or integration. It retains event data and source descriptors, not runtime owners or DOM nodes. In development the Vite plugin also asks the compiler to register each generated binding's template source span (a root-relative template id, a source revision hash, and UTF-16 offsets) and to mark the binding while it is installed, so `bindingForEffect(effectId)`, `bindingsForOwner(ownerId)`, and `liveBindings()` resolve live effects and owners back to the `.td` expression they came from; owners and effects created later by reruns (rows, branches, boundary chunks) stay attributed to the binding that created them, and the entries disappear when the owner or effect is disposed. Bindings inside a row or branch attribute to the enclosing `<for>` or `<if>` binding. Production builds emit none of this instrumentation. Multiple diagnostic consumers can be attached independently and disposing one does not affect the others. Normal compiler-generated production modules do not import this entry, and the Tachyon Vite plugin automatically defines `__TACHYON_PRODUCTION__` for production builds so lifecycle counters and hook calls are removed from the signal hot path. Verify the browser metafile before shipping a custom diagnostic integration.

## Template Language Tooling

`tachyon-dom/template-language` provides a dependency-light semantic layer shared by editor integrations: script/template symbol completion, hover, definition, and scope-aware rename with UTF-16 positions. The language server uses the same compiler and TypeScript template diagnostic paths as the CLI and Vite, including source offsets from `.td` script/template files. `tachyon-dom/template-typecheck` builds a virtual TypeScript program for scope, property, event-handler, model, list, conditional, and await expressions; use `tachyon-dom typecheck <file>` or `tachyonDom({ typecheck: true })` to enable the same checker in CI and Vite. `TypedTemplate` carries a scope type but does not by itself type-check expressions inside a string.

## Progressive Forms

`enhanceForm(form, options)` intercepts submit events only when JavaScript is running, builds a `Request` from the existing form markup, and calls `fetch()` or a custom `submit()` callback. Without JavaScript, the same form remains a normal browser form.

After native validation succeeds, the first submission owns the form until its custom validation and request lifecycle settle. Further submit events are ignored during that interval. Submit buttons are disabled only while the request is pending and each control's original disabled state is restored after success, failure, or cleanup. Disposing the enhancement prevents a late response from navigating or invoking success and error callbacks.

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

`tachyon-dom/server/html` provides an SSR string helper. `html` escapes text interpolation by default, escapes direct interpolation after an attribute assignment, and only renders trusted markup through `rawHtml()`. Use `attr()`, `booleanAttr()`, `classList()`, and `join()` for optional attributes, boolean attributes, class composition, and lists.

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

This helper escapes values; it is not an arbitrary HTML sanitizer. Do not pass user-generated HTML to `rawHtml()`. A trusted fragment must be a complete text-context fragment rather than a partial tag, attribute, comment, or raw-text element. The completed template still applies dangerous-attribute and URL policy checks across trusted-fragment boundaries. For untrusted HTML, sanitize before rendering and keep the sanitizer choice explicit at the application boundary.

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

Client route renderers may return a `ClientMountedView` with `{ value, dispose }`. The router keeps the committed view alive while a next navigation loads, disposes the old view only after the next view commits, disposes uncommitted stale results, and disposes the committed view from `router.dispose()`. `defineClientRoute()` connects a literal path to its loader result so `data` is inferred in `render`, `head`, `target`, and actions while named path segments are inferred in `params`.

`createRouteHotReloader()` invalidates the current route cache entry and re-navigates with `replace: true` when a route module update arrives from a dev server.

`connectRouteHotReloader(import.meta.hot, reloader)` wires Vite-style custom HMR events to the route hot reloader. The Vite routes plugin emits `tachyon-dom:routes-update` when a route module changes.

Routes can define `action()` and `revalidateOnAction`. `router.submit(href, init)` calls the matched action, invalidates cache entries according to the policy, and re-renders the current route.

Client action concurrency is latest-operation-wins. A newer submission or navigation aborts the active action, and a stale response cannot revalidate or redirect. Disposing the router also aborts its active action. When `init.signal` is supplied to `router.submit()`, caller cancellation is composed with the router-owned signal rather than replacing it. An action should still observe its signal and stop expensive work promptly.

## Signals

`runtime/signal` provides `createSignal()`, `createMemo()`, `effect()`, `batch()`, `read()`, `untrack()`, `createResource()`, and `catchError()`. Effects run once when registered, then subsequent signal notifications are queued. Each effect run has its own cleanup owner: `onCleanup()` registrations and a synchronous function returned by the callback run in reverse registration order before the next run and once more when the effect is disposed. The returned function is therefore a cleanup contract, not a value-producing callback. `batch()` groups multiple writes into one flush, and writes made from inside an active effect are queued until that effect exits so the same effect is not synchronously re-entered. A throwing effect does not prevent queued siblings from running. After the queue drains, one unhandled failure is rethrown directly and multiple failures are reported in an ordered `AggregateError`. `untrack(fn)` reads signals without subscribing the active effect, and effects created inside `untrack()` are not attached to the active effect lifecycle. `createMemo()` exposes a cached computed accessor that updates before dependent effects observe the next flush.

Effect callbacks are synchronous. A returned Promise is not a cleanup and asynchronous work must own its `AbortController` or other cleanup synchronously, before the callback returns. A rejection from an async callback is observed by the runtime and delivered to the nearest reactive error owner; an async callback should still be avoided when a synchronous effect plus an explicit task is sufficient. Calling `onCleanup()` after an `await` has no active run owner and does not attach that cleanup to the earlier run; it returns `false` in that case. Use `onCleanup()` before starting the task and check its abort signal in the continuation.

`createResource()` ties an async loader to a source accessor and exposes `data`, `error`, `loading`, `refetch`, `refetchOutcome`, and `dispose`. A plain function passed as `source` is data; only a branded `Accessor` or `createMemo()` is tracked as a source. To combine multiple signals, create a memo explicitly:

```ts
const query = createMemo(() => `${page()}::${filter()}`);
const resource = createResource(query, (key, { signal }) => fetchPage(key, signal));
```

`refetchOutcome()` distinguishes `{ status: "success", data }`, `{ status: "error", error }`, and `{ status: "cancelled", reason }`. Cancellation covers superseded and disposed work, including fetchers that ignore `AbortSignal`. The legacy `refetch()` method remains a compatibility wrapper that resolves data for success and `undefined` for error or cancellation. Only the newest generation may update the declarative resource state.

`createStore()` is shallow. It copies the initial top-level properties and tracks reads and writes by top-level property; nested object mutation is not observed. Replace the top-level value or put a signal at the nested field when nested updates are needed:

```ts
const state = createStore({ user: { name: "Ada" }, online: createSignal(false) });
state.user = { name: "Grace" }; // tracked top-level replacement
state.user.name = "Lin"; // not tracked by createStore itself
state.online.set(true); // tracked nested signal
```

The event runtime registers listeners directly on each target element. It is not a bubbling delegation layer; this preserves non-bubbling `focus`/`blur` behavior and ordinary propagation and `stopPropagation()` semantics.

## Error Boundaries and i18n

`runtime/error-boundary` provides `createErrorBoundary()` for client enhancements that need a local fallback instead of failing the whole mounted region. The nearest active boundary receives later failures from reactive descendants, including descendants created inside `untrack()`. If a fallback throws, the failure continues to its parent boundary. Disposing a boundary detaches the reactive runners it owns. Plain fallback strings are rendered as text. Intentional markup must use `rawHtml()`; DOM `Node`, `DocumentFragment`, and node arrays are also accepted explicitly.

`tachyon-dom/i18n` provides `createI18n()` for dictionary lookup/interpolation and `localeMiddleware()` for request locale selection from route middleware.

## Deferred Data

`runtime/stream-client` provides:

- `readTextStreamChunks(stream)` to decode a `ReadableStream<Uint8Array>` into text chunks.
- `applyDeferredDataChunk(root, chunk)` to write streamed deferred values into `[data-tachyon-deferred-target="id:key"]` elements.
- `readDeferredDataScriptResult(root, id)` to read server-emitted deferred data scripts while distinguishing missing data from invalid JSON without throwing.
- `readDeferredDataScript(root, id)` as a deprecated compatibility wrapper that returns `undefined` for both missing and invalid data.
