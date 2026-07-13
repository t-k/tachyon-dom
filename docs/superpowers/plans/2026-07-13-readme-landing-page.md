# README Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reference-heavy root README with a concise, evidence-backed landing page while preserving detailed guidance in focused documentation.

**Architecture:** The root README becomes a 150–200 line overview with one supported `.td` example, an abbreviated generated-code excerpt, measured minimal-entry and complete-example client bundle sizes, a provenance-backed benchmark summary, installation, and a documentation index. Existing detail moves into focused app/Vite, adapter, security, and whitespace migration guides; source-aware Vitest checks enforce message order, evidence links, line budget, and destination coverage.

**Tech Stack:** Markdown, TypeScript, Vitest, esbuild metafile verification, Playwright Chromium local benchmark runner, OxLint, TypeScript compiler.

---

### Task 1: Lock the landing-page contract with a failing documentation test

**Files:**
- Create: `tests/readme-landing.test.ts`
- Modify: `tests/dx.test.ts:250-360`

- [ ] **Step 1: Write the failing README structure and evidence test**

Create `tests/readme-landing.test.ts` with real filesystem checks:

```ts
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string): Promise<string> => readFile(path.join(root, file), "utf8");

describe("README landing page", () => {
  it("leads with the product message, example, generated output, and evidence", async () => {
    const readme = await read("README.md");
    const lines = readme.split("\n");
    const message =
      "Tachyon DOM is an experimental HTML-first compiler that turns static templates into direct DOM updates, using a small fine-grained runtime shared with SSR and streaming targets.";

    expect(lines.length).toBeGreaterThanOrEqual(150);
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines.slice(0, 8).join("\n")).toContain(message);
    expect(readme).toContain("## Why Tachyon DOM?");
    expect(readme).toContain("## Quick Example");
    expect(readme).toContain("<button on:click={increment}>{count}</button>");
    expect(readme).toContain('<for each={rows} key={row.id}>');
    expect(readme).toContain("## What the Compiler Emits");
    expect(readme).toContain("__tachyonTextAt");
    expect(readme).toContain("__tachyonMountKeyedList");
    expect(readme).toContain("## Measured Size");
    expect(readme).toContain("pnpm check:browser-entry");
    expect(readme).toMatch(/600 bytes/);
    expect(readme).toContain("pnpm check:quick-example-size");
    expect(readme).toMatch(/Quick example client bundle: \d+ bytes minified, \d+ bytes Brotli/);
    expect(readme).toContain("## Reproducible Benchmark");
    expect(readme).toContain("pnpm bench:local");
  });

  it("links every detailed topic to an existing document", async () => {
    const readme = await read("README.md");
    const destinations = [
      "docs/getting-started.md",
      "docs/syntax-spec.md",
      "docs/runtime.md",
      "docs/app-vite.md",
      "docs/routing.md",
      "docs/adapters.md",
      "docs/security.md",
      "docs/migrations/whitespace.md",
      "benchmark/README.md",
      "docs/releasing.md",
    ];

    for (const destination of destinations) {
      expect(readme).toContain(`(${destination})`);
      await expect(access(path.join(root, destination))).resolves.toBeUndefined();
    }
  });

  it("keeps reference and migration detail out of the landing page", async () => {
    const readme = await read("README.md");

    expect(readme).not.toContain("HTML whitespace policy migration");
    expect(readme).not.toContain("Public boundary");
    expect(readme).not.toContain("The Lambda adapter derives request URLs");
    expect(readme).not.toContain("The client router in `tachyon-dom/runtime/router` supports");
  });
});
```

Update `tests/dx.test.ts` so detailed text assertions read the destination guide instead of requiring the root README. Keep package, CI, and root-entry contract checks in `dx.test.ts`.

- [ ] **Step 2: Run the new contract test and verify RED**

Run:

```sh
pnpm vitest run tests/readme-landing.test.ts tests/dx.test.ts
```

Expected: FAIL because the README exceeds 200 lines and `docs/getting-started.md`, `docs/app-vite.md`, `docs/adapters.md`, `docs/security.md`, and `docs/migrations/whitespace.md` do not yet exist.

- [ ] **Step 3: Commit the RED contract**

```sh
git add tests/readme-landing.test.ts tests/dx.test.ts
git commit -m "test: define README landing page contract"
```

### Task 2: Preserve detailed reference content in focused guides

**Files:**
- Create: `docs/getting-started.md`
- Create: `docs/app-vite.md`
- Create: `docs/adapters.md`
- Create: `docs/security.md`
- Create: `docs/migrations/whitespace.md`
- Modify: `docs/runtime.md`
- Modify: `docs/routing.md`
- Modify: `benchmark/README.md`
- Test: `tests/readme-landing.test.ts`
- Test: `tests/dx.test.ts`

- [ ] **Step 1: Create the getting-started guide**

Move the recommended route-local project shape, `.td` declaration setup, starter commands, CLI initialization behavior, and minimal test example into `docs/getting-started.md`. Start with:

```markdown
# Getting Started

Create a route-local starter:

```sh
npm create tachyon-dom@latest my-app
cd my-app
pnpm install
pnpm dev
```

Tachyon DOM is experimental. Start with a small route or isolated application surface and keep server-side validation and security boundaries explicit.
```

Include the existing `src/routes/index/page.td`, `src/client/main.ts`, `src/app.ts`, `vite.config.ts` layout and the `.td.d.ts`/`tachyon-dom/td-modules` guidance without changing their technical meaning.

- [ ] **Step 2: Create the app and Vite guide**

Move `defineApp()`, `pagesFromRouteFiles()`, `tachyonDom()`, `tachyonApp()`, request logging, request-scoped `tachyonSsr()`, Cloudflare Pages packaging, generated HTML entries, and development/build behavior into `docs/app-vite.md`. Preserve the safe SSR example exactly with:

```ts
import { attr, html } from "tachyon-dom/server/html";

const user = new URL(request.url).searchParams.get("user") ?? "Guest";
const body = html`<main>Hello ${user}</main><script type="module"${attr("src", clientScript ?? "")}></script>`;
return new Response(String(body), {
  headers: { "content-type": "text/html; charset=utf-8" },
});
```

- [ ] **Step 3: Create the adapter guide**

Move Workers, Node, Lambda, Cloudflare Assets, static asset fallthrough, trusted host/origin, proxy, domain-name, buffered, and streaming adapter behavior into `docs/adapters.md`. Organize it as shared contract, Workers, Node, Lambda, and deployment checklist rather than preserving README order.

- [ ] **Step 4: Create the security guide**

Move the sanitizer, trusted HTML, streamed raw HTML, URL allowlist, redirects, Host/proxy, Lambda origin, `server/html`, form action, CSRF, and testing guidance into `docs/security.md`. Begin with a compact rule list:

```markdown
# Security

- Template text interpolation and `tachyon-dom/server/html` interpolation escape by default.
- `rawHtml()`, `trustedHtmlChunk()`, and route `stream()` chunks are trust boundaries.
- Sanitize user-generated markup with a vetted runtime adapter.
- Configure public origins and trusted proxy/host behavior explicitly.
- Apply method and CSRF/Origin checks before direct form actions.
```

- [ ] **Step 5: Create the whitespace migration guide**

Move the complete `HtmlWhitespacePolicy` versus `TemplateWhitespacePolicy` explanation, legacy literal mapping, compatibility aliases, public-boundary outcome table, raw-text/RCDATA/SVG/MathML behavior, and migration examples into `docs/migrations/whitespace.md`. Preserve the table verbatim so no migration outcome is lost.

- [ ] **Step 6: Complete existing runtime, routing, and benchmark destinations**

Add any README-only reactive ownership or runtime cleanup explanation to `docs/runtime.md`. Move README-only router capability details into the relevant sections of `docs/routing.md`. Add a “Reproducing the local keyed benchmark” section to `benchmark/README.md` containing:

```markdown
```sh
pnpm bench:local
```

The canonical local run uses a production Vite build, two warmups, seven measured iterations, Playwright Chromium, and the trimmed mean with a 20% trim fraction. Result JSON is written under `benchmark/local-compare/results/` with command, Git, runtime, host, dependency, and browser provenance.
```

- [ ] **Step 7: Run destination-aware tests**

Run:

```sh
pnpm vitest run tests/readme-landing.test.ts tests/dx.test.ts
```

Expected: the missing-file failures are resolved; README structure assertions remain RED until Task 4.

- [ ] **Step 8: Commit the detailed guides**

```sh
git add docs/getting-started.md docs/app-vite.md docs/adapters.md docs/security.md docs/migrations/whitespace.md docs/runtime.md docs/routing.md benchmark/README.md tests/dx.test.ts
git commit -m "docs: move reference material into focused guides"
```

### Task 3: Add a reproducible complete-example client bundle contract

**Files:**
- Create: `scripts/verify-quick-example-bundle.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/readme-landing.test.ts`

- [ ] **Step 1: Add the failing package and CI contract assertions**

Extend `tests/readme-landing.test.ts` to read `package.json` and `.github/workflows/ci.yml` and assert:

```ts
expect(packageJson.scripts["check:quick-example-size"]).toBe(
  "node scripts/verify-quick-example-bundle.mjs",
);
expect(ci).toContain("pnpm check:quick-example-size");
```

Run `pnpm vitest run tests/readme-landing.test.ts` and expect RED because the script and workflow step do not exist.

- [ ] **Step 2: Implement the exact quick-example compiler and bundle measurement**

Create `scripts/verify-quick-example-bundle.mjs`. It must import `brotliCompressSync` from `node:zlib`, compile the exact Task 4 template through the built compiler/SFC API, bundle the generated client module with esbuild using `platform: "browser"`, `format: "esm"`, `bundle: true`, `minify: true`, `metafile: true`, and `write: false`, then print one stable sentence beginning with `Quick example client bundle:` and containing the measured minified bytes, Brotli bytes, and input count.

Use the same forbidden-input patterns as `scripts/verify-browser-entry.mjs` for TypeScript, parse5, language-server, compiler, server, app, and HTML-whitespace modules. Add explicit minified and Brotli budgets after recording the first clean measurement; budgets must leave only a small documented regression margin rather than being copied from unrelated size-limit entries.

- [ ] **Step 3: Add the package command and CI step**

Add:

```json
"check:quick-example-size": "node scripts/verify-quick-example-bundle.mjs"
```

Run it after `pnpm check:browser-entry` in `.github/workflows/ci.yml`.

- [ ] **Step 4: Build and verify the complete-example measurement**

Run:

```sh
pnpm build
pnpm check:quick-example-size
pnpm vitest run tests/readme-landing.test.ts
```

Expected: the script reports non-zero minified and Brotli sizes, contains no forbidden browser inputs, stays within both budgets, and the package/CI assertions pass.

- [ ] **Step 5: Commit the bundle contract**

```sh
git add scripts/verify-quick-example-bundle.mjs package.json .github/workflows/ci.yml tests/readme-landing.test.ts
git commit -m "test: measure the quick example client bundle"
```

### Task 4: Replace the README with the landing page

**Files:**
- Modify: `README.md`
- Test: `tests/readme-landing.test.ts`

- [ ] **Step 1: Write the landing-page hero and value proposition**

Replace the opening with the approved positioning statement and four compact reasons:

```markdown
# Tachyon DOM

Tachyon DOM is an experimental HTML-first compiler that turns static templates into direct DOM updates, using a small fine-grained runtime shared with SSR and streaming targets.

> Experimental status: the compiler and runtime are usable for evaluation, examples, and incremental adoption, but the public API may still change before a stable release.

## Why Tachyon DOM?

- HTML stays recognizable while dynamic fields become explicit DOM paths.
- Fine-grained updates write to cached text, attribute, class, and list targets without a virtual DOM.
- One parsed template feeds client, buffered SSR, and streaming server targets.
- Browser-safe subpath imports keep compiler and server dependencies out of client bundles.
```

- [ ] **Step 2: Add the supported counter and keyed-list example**

Use a roughly 20-line `.td` example with `createSignal`, a counter button, and keyed rows:

```html
<script setup lang="ts">
const count = createSignal(0);
const rows = createSignal([
  { id: 1, label: "Alpha" },
  { id: 2, label: "Beta" },
]);
const increment = (): void => count.update((value) => value + 1);
</script>

<main>
  <button on:click={increment}>{count}</button>
  <ul>
    <for each={rows} key={row.id}>
      <li>{row.label}</li>
    </for>
  </ul>
</main>
```

State that interpolation is escaped on server targets and that the client compiler records direct binding paths.

- [ ] **Step 3: Add an abbreviated generated-code excerpt**

Label the excerpt “abbreviated” and include only real helper names and mechanics:

```js
const countText = __tachyonTextAt(root, [0, 0]);
cleanups.push(__tachyonEffect(() => __tachyonSetText(countText, __tachyonRead(scope.count))));
cleanups.push(
  __tachyonEffect(() =>
    __tachyonMountKeyedList(listRoot, [], __tachyonRead(scope.rows), listOptions),
  ),
);
```

Link to `docs/syntax-spec.md` for exact target behavior.

- [ ] **Step 4: Add measured size, benchmark, install, docs, status, commands, and license**

Document the current browser consumer contract as:

```markdown
## Measured Size

State that `import { createSignal } from "tachyon-dom"` bundles to **600 bytes minified** in the current esbuild check. On the next line, copy the exact minified and Brotli byte counts printed by `pnpm check:quick-example-size` for the complete counter/keyed-list example. CI also verifies that TypeScript, parse5, compiler, server, and language-server modules are absent from both metafiles.

```sh
pnpm build
pnpm check:browser-entry
pnpm check:quick-example-size
```
```

For the benchmark section, initially link the methodology and reserve the numeric table for Task 5’s clean artifact. Add `npm create tachyon-dom@latest my-app`, the ten-document index from Task 1, a short security warning linking `docs/security.md`, the minimal contributor commands (`pnpm install`, `pnpm test`, `pnpm build`, `pnpm lint`), and the MIT license.

- [ ] **Step 5: Run the landing-page contract and verify GREEN except benchmark artifact assertions introduced in Task 5**

Run:

```sh
pnpm vitest run tests/readme-landing.test.ts tests/dx.test.ts
```

Expected: PASS for line budget, section order, example, generated excerpt, size, links, and moved-detail assertions.

- [ ] **Step 6: Commit the new README**

```sh
git add README.md tests/readme-landing.test.ts
git commit -m "docs: turn README into a project landing page"
```

### Task 5: Produce and publish a provenance-backed benchmark snapshot

**Files:**
- Create: `benchmark/local-compare/results/2026-07-13-readme-baseline.json`
- Modify: `README.md`
- Modify: `tests/readme-landing.test.ts`
- Modify: `docs.local/logs/2026-07-13/2026-07-13-002-readme-landing-page.md`

- [ ] **Step 1: Create a clean benchmark worktree at the current committed revision**

Use a sibling worktree so the user’s existing untracked `docs/issues/` does not make provenance dirty:

```sh
git worktree add ../tachyon-dom-readme-benchmark HEAD
```

Verify:

```sh
git -C ../tachyon-dom-readme-benchmark status --short
```

Expected: no output.

- [ ] **Step 2: Run the canonical bounded local benchmark in the clean worktree**

Run:

```sh
pnpm --dir ../tachyon-dom-readme-benchmark install --frozen-lockfile
pnpm --dir ../tachyon-dom-readme-benchmark bench:local
```

Expected: production mode, two warmups, seven measured iterations, a new schema v2 JSON result, and no leaked Vite/Chromium process after completion. Verify the result has `.schemaVersion == 2`, `.provenance.git.dirty == false`, `.workload.iterations == 7`, `.workload.warmup == 2`, and `.workload.serveMode == "production"` with `jq`.

- [ ] **Step 3: Copy the benchmark artifact into the main worktree and remove the temporary worktree**

Copy only the new JSON result to `benchmark/local-compare/results/2026-07-13-readme-baseline.json`, preserving its internal capture timestamp and provenance, then remove the clean worktree:

```sh
git worktree remove ../tachyon-dom-readme-benchmark
```

Confirm no benchmark dev server or Chromium process owned by the run remains before continuing.

- [ ] **Step 4: Add the failing artifact-specific README assertion**

Extend `tests/readme-landing.test.ts` with the exact committed artifact path and its validated summary values:

```ts
const artifact = "benchmark/local-compare/results/2026-07-13-readme-baseline.json";
const result = JSON.parse(await read(artifact)) as {
  schemaVersion: number;
  provenance: { git: { dirty: boolean } };
  workload: { iterations: number; warmup: number; serveMode: string };
  measurements: { tables: { directComparisons: string } };
};
expect(result.schemaVersion).toBe(2);
expect(result.provenance.git.dirty).toBe(false);
expect(result.workload).toMatchObject({ iterations: 7, warmup: 2, serveMode: "production" });
expect(readme).toContain(`(${artifact})`);
expect(readme).toContain(result.measurements.tables.directComparisons.split("\n")[2]!.split("|")[3]!.trim());
```

Run the test and verify RED because the README does not yet name the artifact or result value.

- [ ] **Step 5: Add the compact benchmark table and evidence caveat**

Add a three-row direct-comparison table derived from the artifact’s `measurements.tables.directComparisons`, identifying the baseline, candidate, trimmed geomean ratio, result date, Chromium version, CPU model, and seven-iteration production contract. State that this local keyed-list workload is indicative of the measured machine and is not a universal framework ranking. Link the JSON artifact and `benchmark/README.md`, then show:

```sh
pnpm bench:local
```

- [ ] **Step 6: Verify the benchmark contract and commit**

Run:

```sh
pnpm vitest run tests/readme-landing.test.ts tests/benchmark-provenance.test.ts tests/statistical-authority.test.ts
```

Expected: PASS.

Commit:

```sh
git add README.md tests/readme-landing.test.ts benchmark/local-compare/results/2026-07-13-readme-baseline.json
git commit -m "docs: publish reproducible README benchmark snapshot"
```

### Task 6: Verify documentation integrity and finish the work log

**Files:**
- Modify: `docs.local/logs/2026-07-13/2026-07-13-002-readme-landing-page.md`

- [ ] **Step 1: Run targeted documentation and evidence tests**

```sh
pnpm vitest run tests/readme-landing.test.ts tests/dx.test.ts tests/benchmark-provenance.test.ts tests/statistical-authority.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package and repository verification**

```sh
pnpm lint
pnpm build
pnpm check:browser-entry
pnpm check:quick-example-size
pnpm test -- --reporter=dot
```

Expected: all commands exit 0. Record any pre-existing lint warnings separately from failures.

- [ ] **Step 3: Check links, whitespace, line budget, and process hygiene**

```sh
git diff --check
wc -l README.md
pgrep -af 'vite|vitest|workerd|wrangler|chrome-headless|playwright-mcp' || true
```

Expected: no diff whitespace errors; README is 150–200 lines; no process started by this task remains. Do not terminate unrelated pre-existing processes.

- [ ] **Step 4: Complete the ignored Japanese work log**

Record the classification as a document/mental-model gap, destination documents, benchmark artifact path and summary, verification results, commit hashes, retained pre-existing `docs/issues/`, and process cleanup in `docs.local/logs/2026-07-13/2026-07-13-002-readme-landing-page.md`. Do not stage the ignored log.

- [ ] **Step 5: Inspect final repository state**

```sh
git status --short --branch
git log --oneline -6
```

Expected: only the user’s pre-existing untracked `docs/issues/` remains; the ignored work log remains outside Git.
