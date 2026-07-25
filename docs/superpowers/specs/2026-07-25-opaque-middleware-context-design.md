# Opaque Middleware Authorization Context

## Status

Approved for implementation design on 2026-07-25.

## Problem

`requireUser()` records successful authorization in state attached to the router-supplied middleware context with a private `Symbol`. Object-spread wrappers preserve that state, but a wrapper may legally reconstruct the current public structural context from `request`, `url`, `env`, and Workers `bindings`.

When such a wrapper calls `requireUser()` with a cloned `Request`, the guard records authorization against the clone while the router checks the original middleware request and its original state. A later middleware may then replace the request, allowing the action to observe request identity data that differs from the data used for authorization.

Documentation currently tells callers to preserve the complete context, but the public TypeScript API accepts manual reconstruction and the runtime does not reject it.

## Goals

- Make a manually reconstructed guard context invalid in TypeScript.
- Reject missing or forged-away authorization context state at runtime before identity lookup or action execution.
- Preserve direct `requireUser()` middleware use.
- Preserve wrappers that derive their context with object spread.
- Preserve denial responses, request-local state isolation, and the successful guard return value of `void`.
- Preserve typed Workers bindings.
- Keep the opaque authorization mechanism out of the user-facing API surface.

## Non-goals

- Do not add a general middleware context cloning utility.
- Do not change `RouteMiddlewareResult`.
- Do not return an authorization receipt from successful guards.
- Do not make trusted application middleware a security boundary against deliberately malicious code.
- Do not refactor unrelated request snapshot or middleware body handling.

## Public type design

Introduce an exported `RouteMiddlewareContext` type and use it as the parameter of `RouteMiddleware`.

The type includes the existing `request`, `url`, and `env` fields plus one required property keyed by a module-private `unique symbol`. The property value is an internal mutable authorization state object. The symbol and state type are not exported.

This design has the following intended TypeScript behavior:

- A middleware receives a valid branded context from the router.
- `{ ...context }` and `{ ...context, request: context.request.clone() }` preserve the required symbol property and remain valid guard inputs.
- `{ request, url, env }` is not assignable to `RouteMiddlewareContext`.
- Workers middleware uses `RouteMiddlewareContext & { bindings: Env }`, so reconstructing only the public named fields remains invalid while `bindings` remains strongly typed.
- Middleware callbacks that only read a subset of fields remain source-compatible because receiving a richer context does not require them to access the opaque property.

The built declaration must retain the private `unique symbol` declaration required to express the exported type without exporting a value that consumers can use to manufacture the carrier.

## Runtime design

The router continues to create one authorization state object for each middleware invocation and attaches it to the context as an enumerable symbol property. Enumerability is required so object spread preserves the carrier.

`requireUser()` reads the authorization state before calling `getUser()`. If the carrier is absent, it throws a deterministic `TypeError`. This makes JavaScript callers and TypeScript callers using casts fail closed before an identity lookup can authorize a different request.

On successful identity lookup, `requireUser()` marks the carrier as authorized and preserves the existing `void` result. The router continues to reject any later replacement of the request once the invocation or an earlier invocation has authorized a user.

The existing `WeakSet<Request>` fallback may remain only if current direct-call compatibility still requires it after the branded context is introduced. The opaque per-invocation carrier is authoritative for wrapped calls. Implementation should remove the fallback if tests prove it is redundant, because a second authorization channel increases the number of states that must remain consistent.

## Error behavior

Calling a `requireUser()` guard without a router-issued middleware context throws a `TypeError` with a message explaining that the complete router-supplied context must be preserved.

The error occurs before:

- `getUser()` is called;
- `onUser` is called;
- a denial callback or redirect is produced;
- a subsequent middleware or route action is executed.

Normal authorization denial with a valid context continues to return the configured forbidden response or redirect.

## Compatibility

The following usages remain supported:

- `middleware: [requireUser(getUser)]`;
- wrappers calling `guard({ ...context })`;
- wrappers calling `guard({ ...context, request: context.request.clone() })`;
- Workers middleware reading typed `bindings`;
- middleware functions that destructure only `request`, `url`, or `env`.

The following usage becomes intentionally invalid:

```ts
({ request, url, env, bindings }) =>
  guard({ request: request.clone(), url: new URL(url), env, bindings })
```

JavaScript or cast-based equivalents are rejected at runtime.

## Coverage obligations

| ID | Obligation | Layer | Expected coverage |
| --- | --- | --- | --- |
| `AUTH-CONTEXT-TYPE-1` | Manual reconstruction from named public fields is rejected. | Consumer type contract | A negative TypeScript fixture with `@ts-expect-error`. |
| `AUTH-CONTEXT-TYPE-2` | Object-spread reconstruction remains accepted. | Consumer type contract | A positive TypeScript fixture. |
| `AUTH-CONTEXT-RUNTIME-1` | A cast-based context without the carrier throws before identity lookup. | Router runtime | A focused regression test that also proves `getUser()` and the action were not called. |
| `AUTH-CONTEXT-RUNTIME-2` | An authorized spread wrapper still blocks later request replacement. | Router runtime | Existing cookie mutation regression tests. |
| `AUTH-CONTEXT-DENIAL-1` | A valid wrapped denial keeps its response and redirect semantics. | Router runtime | Existing wrapped denial tests. |
| `AUTH-CONTEXT-WORKERS-1` | Workers bindings remain typed while the carrier is required. | Adapter type contract | Positive spread case and negative manual reconstruction case. |
| `AUTH-CONTEXT-DECLARATION-1` | The installed package declaration preserves the opaque context contract. | Package verification | Build and compile a consumer fixture against the packed or installed package. |
| `AUTH-CONTEXT-ISOLATION-1` | Authorization state remains local to each request. | Concurrent runtime | Existing concurrent wrapper regression, strengthened if necessary so both requests reach the state comparison path. |

Compile-time and runtime tests intentionally overlap because this is a high-risk authorization identity invariant. PICT, TLA+, Alloy, property-based testing, and fuzzing are not applicable to this bounded structural API boundary.

## Verification

Implementation is accepted only when:

- focused runtime and type-contract tests pass;
- generated declarations compile from a consumer perspective;
- the full Vitest suite passes;
- lint and build pass;
- package, exports, starter, browser entry, size, quick example size, whitespace type, and release workflow gates pass;
- Security Specialist review reports no Must Fix findings;
- a clean-context correctness review approves the final diff;
- the worktree is clean apart from intentionally ignored local logs and no task-started processes remain.

## Implementation ownership

The main agent is the single writer. Read-only advisory and final review agents may inspect the design and final diff, but no parallel source writers are used because the router type, Workers adapter type, runtime guard, and regression tests form one tightly coupled change.
