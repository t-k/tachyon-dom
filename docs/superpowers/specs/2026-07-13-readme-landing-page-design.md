# README Landing Page Redesign

## Goal

Turn the root README from an exhaustive reference manual into a concise landing page that explains what Tachyon DOM is, why its compilation model matters, and how a reader can verify its claims before navigating to detailed documentation.

## Audience and Message

The primary audience is a developer encountering Tachyon DOM for the first time on GitHub or npm. The opening statement will be:

> Tachyon DOM is an experimental HTML-first compiler that turns static templates into direct DOM updates, using a small fine-grained runtime shared with SSR and streaming targets.

The first screenful must establish that the project is experimental, HTML-first, compiler-driven, fine-grained, and designed around shared client, SSR, and streaming targets. It must not begin with benchmark implementation history or migration details.

## README Structure

The README will target approximately 150 to 200 lines and use this order:

1. Project name, positioning statement, and experimental status.
2. A short “Why Tachyon DOM?” section describing static template extraction, direct DOM updates, shared targets, and modular browser-safe runtime imports.
3. A roughly 20-line counter and keyed-list template example using supported `.td` syntax.
4. A short generated-code excerpt demonstrating cached DOM targets, fine-grained effects, and keyed-list mounting. The excerpt will be clearly labeled as abbreviated output rather than presented as byte-for-byte compiler output.
5. Measured browser-entry bundle size, its exact measurement command, and the dependency-graph guarantee enforced by CI.
6. A reproducible benchmark summary backed by a committed result artifact. It will state the environment and comparison scope, link directly to the artifact, and include the exact reproduction command. It will avoid unsupported “fastest” or universal performance claims.
7. Installation and the shortest supported starter command.
8. A documentation index linking to syntax, runtime, routing, app/Vite, adapters, security, whitespace migration, testing, benchmarks, and release documentation.
9. A short security and project-status notice.
10. Essential development commands and license.

## Detailed Documentation Boundaries

The README will no longer carry full API inventories, router capability lists, adapter deployment behavior, whitespace-policy migration tables, typed-template internals, or long security recipes. Existing material will be preserved rather than discarded:

- Compiler syntax and generated target behavior belong in `docs/syntax-spec.md`.
- Reactive ownership and browser runtime APIs belong in `docs/runtime.md`.
- Route matching, loaders, actions, streaming routes, CSP, and client navigation belong in `docs/routing.md`.
- App/Vite conventions and HTML whitespace behavior will move to a focused app guide.
- Adapter-specific Node, Workers, Lambda, and Cloudflare Pages behavior will move to an adapter guide.
- Security guidance will move to a focused security guide while the README retains a prominent summary and link.
- Whitespace compatibility and migration tables will move to a dedicated migration guide.
- Benchmark methodology and result interpretation will remain under `benchmark/`, with the README linking to the authoritative artifact and instructions.

If existing detailed documents already cover a passage, the README will link to them instead of duplicating it. New documents will be created only for material that otherwise has no coherent destination.

## Evidence Rules

Bundle and benchmark claims must be reproducible from repository commands and committed artifacts.

- Browser size will come from `pnpm check:browser-entry`. The README test will ensure the documented command and current measured output remain represented. The CI contract continues to reject compiler, server, TypeScript, parse5, and language-server dependencies from the root `createSignal` consumer graph.
- The benchmark table will be derived from one named committed JSON result that satisfies the repository’s benchmark authority rules. The README will identify the benchmark mode, runtime, iteration count, compared implementations, and result date.
- README prose will distinguish the specialized keyed-list benchmark from broader framework and SSR/streaming comparisons.
- Numeric claims will not be copied from transient terminal output without a committed source artifact.

## Content Migration and Compatibility

This change modifies documentation only. Public exports, runtime behavior, compiler output, and benchmark implementation will not change. Existing README anchors may disappear, so every removed detailed section must have a destination link in the new documentation index or an explicit replacement document.

The root README remains English because Tachyon DOM is a public library. Local work logs remain Japanese.

## Verification

Documentation tests will verify:

- the positioning statement appears near the top;
- the quick example contains both counter and keyed-list behavior and uses supported syntax;
- the generated-code excerpt names the actual modular runtime helpers used by current output;
- the browser bundle command and current measured size are present;
- the benchmark claim links to an existing committed artifact and names its reproduction command;
- every documentation link resolves to an existing file or section;
- detailed whitespace migration and router capability content no longer lives in the root README;
- security guidance remains discoverable;
- existing DX tests updated for moved text still protect the destination documents.

Final verification will run the targeted documentation tests, `pnpm lint`, `pnpm build`, `pnpm check:browser-entry`, and the full Vitest suite. No benchmark rerun is required if the README cites an already-authoritative committed result without changing benchmark code; otherwise a new bounded benchmark run must be recorded before publishing a number.

## Out of Scope

- Changing runtime or compiler behavior.
- Redesigning the documentation website or adding a documentation generator.
- Producing new performance claims unsupported by the existing benchmark authority model.
- Removing detailed information without preserving it in an appropriate documentation destination.
