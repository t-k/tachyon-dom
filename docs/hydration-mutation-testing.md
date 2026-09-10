# Hydration mutation testing

Run `pnpm test:mutation:hydration` to repeat the focused compiler and conditional-runtime campaign. Reports are written to `reports/mutation/hydration/`. This supplements `pnpm test:mutation:full`; it does not measure the entire repository or replace the production browser suite.

The configuration mutates the same functions the original review covered (`innermostOwner`, `setupHydration`, `mountResolvedConditional`, the row hydration phase of `createRecord`, `recordHydrationIds`, the hydrate-only binding filter of `generateClientModule`, `templateScopeIdentifiers`, the import section of `topLevelBindings`, `canNarrowSetupScope`, and the exposed-binding selection of `transformSfcScriptUncached`). The line ranges in `stryker.hydration.config.json` are anchored to the source layout of commit `0ef45ce` (2026-09-11). When those functions move, update the ranges and review the mutant inventory before comparing scores. No surviving mutation is suppressed. Incremental reuse is disabled so that each run verifies the current tests.

## Coverage obligations

The tests use the real runtime, hydration scheduler, signals, error handlers, and ownership cleanup. The fixture's hydration wrapper only records handles returned by the actual boundary factory.

| Contract                                                                                   | Tests                                                                               |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Runtime setup declarations, type declarations, and anonymous export diagnostics            | `sfc-import-bindings.test.ts`                                                       |
| Independent eager, load, sibling, and nested hydration boundaries                          | `conditional-hydration-contracts.test.ts`                                           |
| Subscription handoff failures, batched rollback, and immediate retry from an error handler | `conditional-hydration-contracts.test.ts`, `conditional-hydration-rollback.test.ts` |
| Ref release, stale event removal, and nested subtree cleanup                               | `conditional-hydration-contracts.test.ts`                                           |
| Empty SSR text materialization, subsequent updates, and branch removal                     | `conditional-hydration-contracts.test.ts`, `hydration-deferred-updates.test.ts`     |
| Fragment boundary discovery, omitted paths, missing markers, and duplicate markers         | `conditional-hydration-contracts.test.ts`                                           |
| Prepared anchor node counts and sibling paths                                              | `runtime-mount.test.ts`                                                             |
| Failed hydration error and detached descendant retention                                   | `conditional-hydration-contracts.test.ts`                                           |

The two retention tests run real V8 garbage collection through Node's `node:v8` and `node:vm`, cross job boundaries before collection, and inspect `WeakRef` targets. They keep the branch mounted to distinguish timely release from eventual branch disposal. They require the repository's supported Node runtime; they do not run in a browser. The detached-node case checks unnecessary retention after removal, not support for rerendering an externally modified DOM tree. Its live child-node collection is refreshed after removal so that jsdom's lazy collection cache does not retain the removed node itself.

## Survivor ledger

The per-mutant ledger recorded for the 2026-09 campaign below is superseded: the 2026-09-11 region-marker and reactivity changes moved and rewrote the mutated functions, and the current Stryker version generates more mutants per line, so mutant IDs and counts are not comparable with the earlier campaign. The equivalence arguments that still hold are kept as groups rather than IDs. Reassess them whenever input validation, cleanup behavior, or revision consumers change.

| Group                                                                                                         | Where                                        | Why current public behavior is unchanged                                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choice between `renderableChildren(node)` and `node.children`                                                 | `client.ts` `recordHydrationIds`             | Their only difference is removal of empty text nodes, which the validated compilation pipeline never supplies here.                                  |
| Assume a component has one child                                                                              | `client.ts` `recordHydrationIds`             | IR validation rejects components without exactly one renderable root before lowering.                                                                |
| Seed `newlyHydrated` with an extra string                                                                     | `conditional.ts` `setupHydration`            | Disposal deletes that string from a set of binding objects; no real binding is affected.                                                             |
| Always dispose the successful hydration handle during rollback                                                | `conditional.ts` `setupHydration`            | The real boundary factory only invokes the binder after successful location, so an error result cannot reach this callback.                          |
| Decrement rather than increment the revision                                                                  | `conditional.ts` `setupHydration`            | Consumers only observe a change and discard the value.                                                                                               |
| Omit the empty-hydration early return                                                                         | `conditional.ts` `mountResolvedConditional`  | The subsequent binding list is empty and the same pending set is cleared; only traversal is added.                                                   |
| Duplicate cleanup calls (`states.delete`, `setPreparedConditionalNodeCount(anchor, 0)`, `detachOwnerCleanup`) | `conditional.ts` hide path and owner cleanup | Each call is repeated by the owner-cleanup registration that runs on the same path, so removing one occurrence leaves the other to do the same work. |

Survivors outside these groups are open. The main open areas after the 2026-09-11 campaign are the hydration boundary option passthrough (`media`, `rootMargin`, `strategy`, `replayInteraction`) in both the branch and row runtimes, the unresolved row boundary id and adoption error paths in `createRecord`, the `canNarrowSetupScope` classification of declaration initializers, and the `scopeEmission` decision in `transformSfcScriptUncached`. They are tracked as test work, not classified as equivalent.

## Recorded campaign

2026-09 campaign (source layout of `570bc86`, 236 mutations): the review follow-up increased detection from 191 to 225, the raw score from 80.93% to 95.34%, survivors from 32 to 11, and uncovered mutations from 13 to zero, with all 11 survivors accounted for in the ledger of that time.

2026-09-11 campaign (source layout of `0ef45ce`, ranges re-anchored, Stryker 10): 573 mutations, 479 killed, 77 survived, 17 uncovered, no timeouts or errors; raw score 83.60%, covered score 86.15%. Per file: `client.ts` 90.91%, `sfc.ts` 88.51%, `conditional.ts` 82.21%, `list.ts` 66.67%. The increase in mutation count comes from the re-anchored functions having grown with the region-marker work and from the mutator set of the current Stryker version, so the two campaigns measure different inventories. These numbers describe this focused campaign, not whole-library mutation coverage.
