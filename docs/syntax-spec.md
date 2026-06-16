# Tachyon DOM Syntax Specification

This document fixes the small HTML-first syntax surface used by the compiler, runtime, and SSR targets. JavaScript expressions are intentionally restricted to identifiers and dotted paths for now, so every target can analyze dependencies without evaluating arbitrary code.

## Text Bindings

`{value}` creates a dynamic text slot. The client target leaves a placeholder text node in the static template and updates it through `runtime/text`. The server targets emit an HTML-escaped value.

```html
<h1>{title}</h1>
```

## Conditional Rendering

`<if test={condition}>...</if>` renders children only when `test` is truthy. The client target lowers it to a comment anchor plus a `runtime/conditional` binding. The server targets omit the children when the condition is falsy.

```html
<if test="{active}">
  <button>{count}</button>
</if>
```

## Keyed Lists

`<for each={items} key={item.id}>...</for>` creates a keyed list boundary. The first identifier in `key` becomes the item binding name. The client target lowers it to `runtime/list`; the server targets render the array in order.

```html
<ul>
  <for each="{rows}" key="{row.id}">
    <li>{row.label}</li>
  </for>
</ul>
```

## Stores

`<store name={initial}/>` defines state without emitting a DOM node. The client target imports `runtime/store` only when a template declares stores.

```html
<store count="{initialCount}" />
```

Inside a component, store declarations create local server/stream scope values for that component subtree.

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

`hydrate:id={islandId}` connects SSR HTML to client hydration. The client template removes the attribute. The server targets wrap the element with marker comments:

```html
<!--tachyon-hydrate:<id>:start-->
<section>...</section>
<!--tachyon-hydrate:<id>:end-->
```

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

## Compiler Pipeline

The compiler pipeline is:

```text
HTML parser -> Template IR -> client target / server string target / server stream target
```

`CompiledTemplate.ir.directives` records `store`, `component`, `hydrate`, `if`, `event`, `for`, and `await` directives. Each target consumes the same parsed root and IR contract.
