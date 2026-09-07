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

The client compiler records static element siblings around a direct `<for>` so SSR rows can be adopted without consuming those siblings. The region uses element counts to place rows between those siblings and records a separate logical child index when text or comment nodes make the binding path longer than the element count. Bindings before the list keep their logical paths, while bindings after the list account for the expanded row region. A direct `<for>` can be hydrated when it is the sole dynamic region under its parent. This rule is checked recursively inside list row templates as well. If a `<for>` shares its parent with another direct `<for>` or `<if>`, `hydrate()` reports an ambiguous dynamic-region error before binding and leaves the SSR DOM untouched. Place the dynamic regions under separate parent elements when they must be hydrated together. Conditional branches with the same client shape as a static or conditional sibling are also rejected before binding because SSR output cannot identify their ownership.

Transparent `<component>` boundaries are flattened for this parent check. A list or conditional inside a transparent component therefore shares the surrounding DOM parent, and it is rejected by the same pre-hydration diagnostic when another dynamic region is present.

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

`<component name="Name">...</component>` creates a transparent component boundary. It does not emit a wrapper element. A component must currently have exactly one renderable root child.

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

`<outlet></outlet>` injects `scope.outlet` in server and stream targets. The client target leaves a marker comment.

`<slot name="header"></slot>` injects `scope.slots.header` in server and stream targets. The client target leaves a marker comment.

These are intended for route layouts and transparent component composition.

## Await Streaming

`<await value={promise} then="name">...</await>` creates an async streaming fragment. The stream target awaits `value`, binds the resolved value to `then`, and yields the child HTML as soon as it is ready.

```html
<await value="{messagePromise}" then="message">
  <p>{message}</p>
</await>
```

The synchronous server string target treats the current `value` as the resolved value. Use the stream target when `value` is a Promise.

`<await>` also accepts:

- `fallback="..."` to yield static fallback HTML before awaiting in the stream target.
- `error="..."` to yield static error HTML if the awaited value rejects in the stream target.
- `reorder="preserve"` or `reorder="resolve"` in the IR. The client and buffered server targets do not use this streaming ordering hint. The stream target currently supports document-order output (`preserve` or omission); `reorder="resolve"` is rejected with a positioned diagnostic until resolve-order emission is implemented.

## Single File Templates

`.td` files can contain one optional `<script>` block plus template markup. The compiler removes the script block before parsing the template and maps template diagnostics back to the original source offsets.

Script-only `.td` files are valid and emit empty client, server, or stream template modules. `<script setup>` exposes top-level bindings through a per-bind setup factory, so signal state and setup effects are independent for each client instance and request. Imports remain module-scoped. A named `export const scope` or `export default` can provide an explicit shared or factory default scope, but a file must not use both forms at once. `script setup` must not contain exports; use a normal `<script>` block when module-shared state or explicit exports are required.

Template scripts can use compiler helper names such as `validateFormData` and `compileTachyonSfc`; the SFC transform auto-imports supported helpers from Tachyon DOM modules.

## Compiler Pipeline

The compiler pipeline is:

```text
HTML parser -> Template IR -> client target / server string target / server stream target
```

`CompiledTemplate.ir.directives` records `store`, `component`, `hydrate`, `if`, `event`, `for`, and `await` directives. Each target consumes the same parsed root and IR contract.
