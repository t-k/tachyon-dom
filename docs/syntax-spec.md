# Tachyon DOM Syntax Specification

This document fixes the small HTML-first syntax surface used by the compiler, runtime, and SSR targets. Template expressions are parsed into Tachyon DOM's compiler IR before they are emitted to client, server string, and server stream targets.

## Expressions

The default expression parser is `auto`: it first uses the small native parser for the hot path, then falls back to OXC for syntax the native parser does not cover. `parseExpression(source, { backend: "native" | "oxc" | "auto" })` can pin a backend for tests and compiler benchmarking.

Supported expression forms include identifiers, dotted paths, literals, arrays, objects, unary `!` and `-`, binary arithmetic/comparison/logical operators, ternaries, calls, optional chaining, nullish coalescing, computed member access, and template literals. Assignable expressions for `bind:*` accept identifier paths and non-optional member expressions.

Expressions are a compiler/runtime convenience for developer-authored templates, not a sandbox for untrusted input. The parser rejects `constructor`, `__proto__`, and `prototype` anywhere they would name an identifier path, object key, or member property, but callers must not expose expression strings as user-controlled policy or scripting input.

## Text Bindings

`{value}` creates a dynamic text slot. The client target leaves a placeholder text node in the static template and updates it through `runtime/text`. The server targets emit an HTML-escaped value.

```html
<h1>{title}</h1>
```

Expressions inside `script` and `style` are rejected because ordinary HTML escaping corrupts raw text, while removing escaping would permit closing-tag breakout. Keep JavaScript and CSS static or external. For framework hydration data, use `serializeHydrationState(id, state)`, which applies the dedicated script-data serialization contract.

`textarea` and `title` remain RCDATA elements. Dynamic values inside them continue through normal HTML text escaping so the browser reconstructs the intended text value.

## Conditional Rendering

`<if test={condition}>...</if>` renders children only when `test` is truthy. The client target lowers it to a comment anchor plus a conditional binding; branches limited to text, class, attr, style, and event bindings use `runtime/conditional-core`, while branches with stores, components, lists, models, refs, or hydration boundaries use the generic `runtime/conditional` path. The server targets omit the children when the condition is falsy.

```html
<if test="{active}">
  <button>{count}</button>
</if>
```

## Keyed Lists

`<for each={items} key={item.id}>...</for>` creates a keyed list boundary. The first identifier in `key` becomes the default item binding name. Use `as="item"` and `index="index"` to declare the row variables explicitly; these declarations are independent from the key expression. The client target lowers rows containing only text bindings to `runtime/list-text`; rows with attributes, events, models, styles, refs, or nested control flow use `runtime/list`. The server targets render the array in order. Runtime keyed lists accept strings, finite numbers, and symbols as keys; `null`, `undefined`, `NaN`, infinities, objects, and duplicate keys are invalid. Duplicate rows are reported before a new row is committed.

```html
<ul>
  <for each="{rows}" key="{row.id}">
    <li>{row.label}</li>
  </for>
</ul>
```

```html
<ul>
  <for each="{rows}" as="row" index="position" key="{row.id}">
    <li>{position}: {row.label}</li>
  </for>
</ul>
```

Use `update="reference"` when the list follows immutable update discipline and an unchanged item reference should not re-evaluate that row. The default is `update="always"`, which preserves in-place mutation behavior. Index changes and changes to the outer scope still invalidate rows in either mode.

Every `<for>` region is delimited by the same comment markers on every target: `<!--tachyon-for-->` before the rows and `<!--/tachyon-for-->` after them, exactly as `<if>` uses `<!--tachyon-if-->` and `<!--/tachyon-if-->`. The markers are what identify a region: hydration adopts the SSR rows between them, rows are inserted before the end marker, and nested `<for>` and `<if>` regions nest their own pairs. Because ownership is stated by the compiler rather than inferred from the DOM shape, any number of `<for>` and `<if>` regions can share a parent, sit next to whitespace, text, or static siblings, and be hydrated together without wrapper elements:

```html
<ul>
  <for each="{rows}" as="row" key="{row.id}">
    <li>{row.label}</li>
  </for>
  <if test="{loading}">
    <li>Loading</li>
  </if>
</ul>
```

Both markers occupy no logical child slot, so binding paths for siblings after a region are the same in the client template and in the hydrated document. A `<for>` may also be a direct child of an `<if>` branch; the branch owns the pair and removes the rows with itself. A `<for>` placed directly inside a `<for>` row is not supported yet and is reported by the compiler; wrap it in an element. The markers are part of the generated-only contract (see [Public API layers](api.md)): their text may change between compiler versions, and hand-written server HTML that omits them is not supported for hydration.

Transparent `<component>` boundaries emit no element, so a `<for>` or `<if>` inside one shares the surrounding DOM parent; its markers still identify it.

Row-local `<component>` boundaries, `<store>` declarations, and explicit hydration boundaries are supported. Row stores and component props belong to the keyed row and survive reorder while being disposed when the key leaves the list. A row hydration boundary must use an explicit row-scoped expression such as `hydrate:id={row.id}`; an automatically generated static id inside a row is rejected because it would be duplicated. The runtime does not silently drop unsupported metadata.

## Stores

`<store name={initial}/>` defines state without emitting a DOM node. The client target imports `runtime/store` only when a template declares stores.

```html
<store count="{initialCount}" />
```

Inside a component, store declarations create local server/stream scope values for that component subtree.

## Attributes and Bindings

Expression attributes such as `title="{label}"` create dynamic attribute bindings. `class:name={condition}` toggles one class, `style:name={value}` writes one style property, and `ref={path}` stores the element into the provided scope path.

`bind:value={path}` and `bind:checked={path}` create two-way form bindings. The expression must be assignable: either an identifier path or a non-optional member expression.

## Events

`on:event={handler}` creates an event binding. The client target imports `runtime/event` only when events are present. Server targets do not emit event attributes.

```html
<button on:click="{increment}">{count}</button>
```

## Components

Tachyon DOM has two things that are both called "component". They are different, and the syntax keeps them apart:

| Concept                                | What it is                                                                                                                                                | Where it lives              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `<component name="Name">…</component>` | An inline scope boundary inside one template. It declares local prop names and local `<store>` state for its subtree and emits no wrapper element.        | Template syntax             |
| `createTemplateComponent({ … })`       | A reusable unit defined in code: typed props, independent reactive scope per instance, `mount`, `hydrate`, `update`, `dispose`, SSR and stream renderers. | Runtime API (`tachyon-dom`) |

`<component name="Panel">` does not call a `Panel` defined elsewhere. The `name` is a label for diagnostics and generated metadata; the subtree is compiled in place. Think of it as `let` for template scope, not as a function call. To reuse UI across files, define it once with `createTemplateComponent()` and mount or render that instance; the compiler may still emit transparent boundaries inside it, but those are an implementation detail.

`<component>` does not emit a wrapper element. A component must currently have exactly one renderable root child.

Component props are expression attributes other than `name`, and are exposed as local names while rendering the component subtree.

```html
<component name="Panel" label="{title}">
  <section>{label}</section>
</component>
```

Components may be nested, and nested component props are resolved against the parent component scope.

## Hydration Boundaries

`hydrate` marks an element as an SSR hydration boundary. When no explicit id is provided, the compiler generates a stable template-local id from the element path. The client template removes hydration attributes. The server targets wrap the element with marker comments:

```html
<!--tachyon-hydrate:<id>:start-->
<section>...</section>
<!--tachyon-hydrate:<id>:end-->
```

Use `hydrate:id={islandId}` when the same template can be rendered multiple times into one root and the caller needs to provide a unique id.

Hydration strategies can be written as shorthand attributes:

```html
<section hydrate:idle>...</section>
<section hydrate:visible="128px">...</section>
<section hydrate:interaction="pointerenter">...</section>
<section hydrate:media="(min-width: 48rem)">...</section>
```

The supported shorthand names are `hydrate:load`, `hydrate:idle`, `hydrate:visible`, `hydrate:media`, and `hydrate:interaction`. `hydrate:visible` treats its string value as `rootMargin`; `hydrate:media` treats it as the media query; `hydrate:interaction` treats it as the event name. `hydrate:id={id}` can be combined with a strategy shorthand.

`runtime/hydrate` locates marker pairs and hydrates the existing element without replacing SSR DOM. `serializeHydrationState(id, state)` and `readHydrationState(root, id)` provide the first state handoff path.

Hydration can be scheduled by runtime strategy:

- `load`
- `idle`
- `visible`
- `media`
- `interaction`

## Outlet and Slot

`<outlet></outlet>` and `<slot name="header"></slot>` are server-side composition points, not reactive child content. Their contract is deliberately narrow:

| Aspect        | Contract                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type          | An HTML string. `scope.outlet` and `scope.slots[name]` are inserted verbatim by the server and stream targets; `null` or `undefined` inserts nothing.     |
| Evaluated in  | The scope of the template that contains the `<outlet>` or `<slot>`; the string was produced earlier by the caller, usually another template's `render()`. |
| Updates       | Never. The value is read once per render and has no reactive subscription.                                                                                |
| Owner         | None. Nothing inside the inserted HTML is bound, tracked, or disposed by this template.                                                                   |
| Client target | Leaves a marker comment only. `mount()` renders no slot content; `hydrate()` leaves whatever the server inserted in place and does not bind it.           |
| Trust         | The string is trusted HTML. Escape user data before it reaches `scope.outlet` or `scope.slots`, exactly as with `rawHtml()`.                              |

Use them for route layouts and for composing server-rendered fragments. They are not a mechanism for passing reactive UI into a reusable component. For that, mount a `createTemplateComponent()` instance into an element the parent owns (for example via `ref`), so its state, updates, and disposal follow the parent's owner.

## Await Streaming

`<await value={promise} then="name">...</await>` creates an async fragment. The stream target awaits `value`, binds the resolved value to `then`, and yields the child HTML as soon as it is ready.

```html
<await value="{messagePromise}" then="message">
  <p>{message}</p>
</await>
```

`<await>` also accepts:

- `pending="..."` to yield static HTML before awaiting in the stream target. This HTML is appended output: once the value resolves, the resolved children are yielded after it and the pending HTML is not removed or replaced. Use it for a heading or an explanatory line that should remain in the document, not for a spinner that must disappear. `fallback="..."` is accepted as an alias with the same meaning; using both on one element is a compile error.
- `error="..."` to yield static error HTML if the awaited value rejects in the stream target.
- `reorder="preserve"` or `reorder="resolve"` in the IR. The stream target currently supports document-order output (`preserve` or omission); `reorder="resolve"` is rejected with a positioned diagnostic until resolve-order emission is implemented.

Per-target meaning:

| Target             | `value` is a plain value                                                                                                                                                                                                                                                                   | `value` is a Promise                                          | `pending` / `error`        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------- |
| Stream             | Rendered as the resolved value                                                                                                                                                                                                                                                             | Awaited; children yielded on resolution                       | Yielded as described above |
| Synchronous server | Rendered as the resolved value                                                                                                                                                                                                                                                             | Rejected with an error at render time; the target cannot wait | Ignored                    |
| Client             | Lowered to a marker comment with no binding. `mount()` renders nothing there; `hydrate()` refuses a template containing `<await>` with a diagnostic, because the server-rendered children would shift later siblings. Load data with `createResource()` and render it with `<if>` instead. |                                                               |                            |

Replacing a placeholder with the resolved UI in the browser would require region identification, a replacement protocol, and a hydration contract. That is not implemented, and the `pending` name is chosen so the current behavior is not mistaken for it.

## Target Contract

Every element form is compiled by the client, synchronous server, and stream targets from the same IR. The rule for differences between them is:

> Where a form is supported by more than one target, it has the same meaning in each. Where a target cannot realize that meaning, it reports a diagnostic instead of silently doing something else.

Examples of the rule in this document: a `<for>` region renders the same rows and the same markers in every target; `<await>` with a Promise in the synchronous server target is an error rather than text; `reorder="resolve"` is rejected by the stream target; `<outlet>` and `<slot>` on the client are documented as markers only rather than being emulated. The lightweight and generic client runtimes chosen for a `<for>` or `<if>` (see `tachyon-dom explain`) differ in size only, never in observable behavior.

## Single File Templates

`.td` files can contain one optional `<script>` block plus template markup. The compiler removes the script block before parsing the template and maps template diagnostics back to the original source offsets.

Script-only `.td` files are valid and emit empty client, server, or stream template modules. `<script setup>` exposes top-level bindings through a per-bind setup factory, so signal state and setup effects are independent for each client instance and request. The factory returns only the bindings whose names appear in the template text; a helper or intermediate value that the template never names still runs in setup but is not copied into the scope object. Imports remain module-scoped. A named `export const scope` or `export default` can provide an explicit shared or factory default scope, but a file must not use both forms at once. `script setup` must not contain exports; use a normal `<script>` block when module-shared state or explicit exports are required.

Template scripts can use compiler helper names such as `validateFormData` and `compileTachyonSfc`; the SFC transform auto-imports supported helpers from Tachyon DOM modules.

## Compiler Pipeline

The compiler pipeline is:

```text
HTML parser -> Template IR -> client target / server string target / server stream target
```

`CompiledTemplate.ir.directives` records `store`, `component`, `hydrate`, `if`, `event`, `for`, and `await` directives. Each target consumes the same parsed root and IR contract.
