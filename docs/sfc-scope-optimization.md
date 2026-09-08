# SFC scope optimization

The CLI and Vite compiler can omit setup properties that the template does not reference. Setup declarations still execute, and closures retain their lexical variables. Template names come from the expression AST used for code generation, including normalized Unicode escapes. Static markup and string literals do not retain setup properties; implicit `outlet` and `slots` references do.

Narrowing is conservative. Scripts using `this`, `eval`, mutable declarations, or assignments retain all setup properties. A directly exposed import, alias, destructured value, or call result also retains the full scope because its callable behavior is unknown. Known local functions and literal values can use the narrower scope. The compiler preserves method-call semantics such as `scope.label()`.

## Reproduce behavior and size comparisons

Run `pnpm build` followed by `pnpm check:sfc-scope-sizes`. The command first executes regression and DOM behavior tests, then prints minified and Brotli measurements for both full and narrowed scopes. The shared fixtures cover internal helpers, closures, imported functions, dynamic `this` access, Unicode names, escaped names, and deferred hydration. DOM tests check rendering, one event per click, and listener cleanup after disposal for both modes.

Run `pnpm test:mutation:sfc` for targeted mutation testing. Reports are written to `reports/mutation/sfc/`. The mutation configuration uses source line ranges, so update those ranges when the scope-analysis functions move.

The measurements describe bundle size, not browser execution speed or retained heap size. The deferred fixture exercises runtime boundary activation; it does not measure a separately downloaded hydration chunk.
