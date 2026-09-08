# SFC scope optimization

Setup factories can omit properties that the template does not reference when called without external input. Generated CLI and Vite entry points supply an input scope, so they retain all setup bindings, even for empty input. Setup declarations still execute, and closures retain their lexical variables. Template names come from the expression AST used for code generation, including normalized Unicode escapes. Static markup and string literals do not retain setup properties; implicit `outlet` and `slots` references do.

Narrowing is conservative. Scripts using `this`, `eval`, `inputScope`, mutable declarations, or assignments retain all setup properties. A directly exposed import, alias, destructured value, or call result also retains the full scope because its callable behavior is unknown. Known local functions and literal values can use the narrower scope only without external input. Supplying any input retains every setup binding because externally supplied or overridden methods can observe the merged scope. The full fallback remains in the bundle, limiting tree shaking; `exposedBindings` describes only the no-input path. The compiler preserves method-call semantics such as `scope.label()`.

## Reproduce behavior and size comparisons

Run `pnpm build` followed by `pnpm check:sfc-scope-sizes`. The command first executes regression and DOM behavior tests, then prints minified and Brotli measurements for both full and narrowed scopes. The shared fixtures cover internal helpers, closures, imported functions, dynamic `this` access, Unicode names, escaped names, direct Signal values, and deferred hydration. DOM tests check rendering, one event per click, and listener cleanup after disposal for both modes. Integrated generated-module tests also pass external methods through `mount()` for both supplementation and overriding.

Run `pnpm test:mutation:sfc` for targeted mutation testing. Reports are written to `reports/mutation/sfc/`. The mutation configuration uses source line ranges, so update those ranges when the scope-analysis functions move.

Generation uses `instrumentBindings: false`, matching production Vite, along with the production bundler define. Output distinguishes no-input `exposed` and `narrowed` from `externalScopeExposed`; a direct Signal call result deliberately keeps the full scope. Recognizing trusted Signal imports is a future optimization, not assumed safe by name.

The measurements describe bundle size, not browser execution speed or retained heap size. The deferred fixture exercises runtime boundary activation; it does not measure a separately downloaded hydration chunk.
