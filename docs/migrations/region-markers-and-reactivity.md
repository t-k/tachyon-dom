# Region Markers and Reactivity Semantics Migration

This guide covers the changes that follow the September 2026 design review: explicit `<for>` region markers, the separation of dependency tracking from ownership in `untrack()`, fresh memo reads inside `batch()`, the `<await>` target contract, and the `pending` attribute.

## `<for>` regions carry markers on every target

Server, stream, and client output now wrap every `<for>` region in `<!--tachyon-for-->` and `<!--/tachyon-for-->`, matching the existing `<if>` markers. Hydration adopts rows between the markers instead of inferring them from element counts between static siblings.

- Templates that had to place a `<for>` under its own parent element because it shared a parent with another `<for>` or `<if>` no longer need the wrapper. The "multiple direct dynamic regions" and "ambiguous conditional hydration region" diagnostics are gone.
- Snapshot tests of server output must include the markers. `renderServerTemplate()` and the stream target produce identical HTML for the same scope.
- Hand-written server HTML without the markers is not a supported hydration input. Regenerate server modules and client modules with the same compiler version.
- A `<for>` that is a direct child of an `<if>` branch is supported. A `<for>` directly inside a `<for>` row is now a compile error (it previously nested its rows inside a sibling element silently); wrap it in an element.
- `runtime/list-path` is no longer imported by generated code. It remains exported with a zero offset and will be removed in the next major release.
- `mountKeyedList()` and `mountTextKeyedList()` on a container without markers synthesize a marker pair around the existing children on first mount. A legacy `region: { before, after }` option or a `<!--tachyon-list-->` comment is still honored to place that pair.

Client bundles grow by the marker-aware walkers: see the README size section for the measured numbers.

## `untrack()` no longer changes ownership

`untrack(fn)` stops dependency tracking only. Effects, resources, and `onCleanup()` registrations created inside it now belong to the enclosing effect run, exactly like those created outside it, and are released before that run repeats.

Code that relied on `untrack()` to make an inner effect outlive the outer effect's reruns must say so explicitly:

```ts
import { detachFromEffectOwner } from "tachyon-dom";

effect(() => {
  const id = selected();
  detachFromEffectOwner(() => {
    // Attached to the enclosing mount or root owner, released on dispose, not on the next rerun.
    effect(() => log(id));
  });
});
```

In most application code the previous behavior was accidental, and no change is needed.

## Memo reads inside `batch()` are fresh

A `createMemo()` accessor read inside `batch()` or inside an effect run now returns the value for the current signal state, recomputing at most once per flush. Code that depended on reading the stale cached value inside a batch must capture the value before writing. If a different queued memo throws during that early recomputation, its error is held until the flush, as before; only the failure of the memo being read reaches the reader immediately.

## `<await>`

- The synchronous server target throws when `value` is a Promise instead of rendering `[object Promise]`. Render with the stream target or resolve the value before rendering.
- The client target lowers `<await>` to a marker comment with no bindings, and `hydrate()` refuses a template that contains `<await>` (the compiler records the diagnostic; `tachyon-dom explain` shows it). Load data in the browser with `createResource()` and render it with `<if>`, or `mount()` the template.
- `pending="..."` is the documented name for the HTML the stream target yields before awaiting. It is appended output and is not replaced when the value resolves. `fallback="..."` remains an alias; using both on one element is a compile error. The IR records both `pending` and `fallback`.

## Explaining cost

`tachyon-dom explain <file>` and `explainCompiledTemplate()` from `tachyon-dom/compiler` report which runtime module each `<for>` and `<if>` uses and why, the runtime imports of the client module, and any compile-time hydration diagnostics.
