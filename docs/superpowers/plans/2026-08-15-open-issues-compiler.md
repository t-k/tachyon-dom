# Open Issue Compiler and Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issues 001, 003, 009, 010, and 029 with stable DOM paths, explicit unsupported syntax, lossless SFC extraction, and class parity.

**Architecture:** Normalize or reject parser-sensitive shapes before target lowering. Represent an empty dynamic text anchor explicitly so SSR and hydration share a node, and combine class sources into one binding rather than allowing independent attribute and directive writers to race.

**Tech Stack:** TypeScript compiler pipeline, parse5, Vitest/jsdom, Playwright, compiler benchmarks.

---

### Task 1: Stabilize empty text hydration anchors (Issue 001)

**Files:**
- Modify: `src/compiler/targets/server.ts`
- Modify: `src/compiler/targets/stream.ts`
- Modify: `src/runtime/text.ts`
- Test: `tests/compiler.test.ts`
- Test: `tests/runtime-hydrate.test.ts`
- Create: `tests/open-issues-browser.test.ts`

- [ ] **Step 1: Write failing server and hydration tests**

```ts
it.each(["", null, undefined])("hydrates empty text value %j without path drift", async (value) => {
  const fixture = await renderAndHydrate(`<p>a{value}b</p>`, { value });
  expect(fixture.element.childNodes[1]?.nodeType).toBe(Node.TEXT_NODE);
  fixture.scope.value = "Z";
  expect(fixture.element.textContent).toBe("aZb");
});
```

Add parity assertions for direct server, generated server, and generated stream. Preserve exact non-empty snapshots.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/compiler.test.ts tests/runtime-hydrate.test.ts -t 'empty text'`

Expected: the parsed SSR DOM lacks the expression node or writes to the wrong node.

- [ ] **Step 3: Emit and consume an empty-text marker**

```ts
export const EMPTY_TEXT_MARKER = "<!--td:text-->";

const renderTextExpression = (value: unknown): string => {
  const escaped = escapeHtml(value);
  return escaped === "" ? EMPTY_TEXT_MARKER : escaped;
};

export const textAt = (root: Node, path: readonly number[]): Text => {
  const node = nodeAt(root, path);
  if (node.nodeType === Node.COMMENT_NODE && node.nodeValue === "td:text") {
    const text = document.createTextNode("");
    node.parentNode?.replaceChild(text, node);
    return text;
  }
  if (node.nodeType !== Node.TEXT_NODE) throw new TypeError("Text binding path did not resolve to a Text node");
  return node as Text;
};
```

Use the renderer helper in direct, generated, and stream text-expression paths only when the evaluated value is empty.

- [ ] **Step 4: Verify GREEN in unit and real DOM**

```bash
pnpm exec vitest run tests/compiler.test.ts tests/runtime-hydrate.test.ts
pnpm exec vitest run tests/open-issues-browser.test.ts -t 'hydrates empty text'
```

Expected: initial SSR has stable placement, hydration reuses the element, updates reach Text nodes, and no browser exception occurs.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/targets/server.ts src/compiler/targets/stream.ts src/runtime/text.ts tests/compiler.test.ts tests/runtime-hydrate.test.ts tests/open-issues-browser.test.ts
git commit -m "fix: preserve empty text hydration anchors"
```

### Task 2: Make SFC script extraction structural (Issue 003)

**Files:**
- Modify: `src/compiler/sfc.ts`
- Test: `tests/dx.test.ts`
- Test: `tests/open-issues-browser.test.ts`

- [ ] **Step 1: Record the SFC baseline**

```bash
TD_BENCH_RUN="2026-08-15-003-node-$(node -p 'process.version')"
mkdir -p "benchmark/compiler/results/$TD_BENCH_RUN"
pnpm bench:sfc | tee "benchmark/compiler/results/$TD_BENCH_RUN/before-sfc.txt"
```

- [ ] **Step 2: Write failing placement and syntax tests**

```ts
it("preserves template scripts after the setup block", () => {
  const source = `<script>const title = "x";</script><main><script type="application/ld+json">{"x":1}</script>{title}</main>`;
  const result = compileFile("fixture.td", source);
  expect(result.code).toContain('type="application/ld+json"');
});

it("does not treat a nested script as setup", () => {
  const result = compileFile("fixture.td", `<main><script src="/client.js"></script></main>`);
  expect(result.code).toContain("/client.js");
});
```

Add invalid plain JavaScript and TypeScript cases that assert source-positioned diagnostics.

- [ ] **Step 3: Verify RED**

Run: `pnpm exec vitest run tests/dx.test.ts -t 'template scripts|nested script|setup block'`

Expected: the nested or JSON-LD script is removed or conflicts with the setup block.

- [ ] **Step 4: Replace global script regex extraction**

```ts
type LeadingScriptBlock = { attributes: string; content: string; start: number; end: number };

const findLeadingScriptBlock = (source: string): LeadingScriptBlock | undefined => {
  const start = skipWhitespaceAndHtmlComments(source, 0);
  if (!source.slice(start).match(/^<script(?:\s|>)/i)) return undefined;
  return readBalancedTopLevelScript(source, start);
};
```

Remove only this leading block from the template source. Parse JavaScript and TypeScript setup content through the existing diagnostic pipeline so invalid syntax never passes silently.

- [ ] **Step 5: Verify, benchmark, and commit**

```bash
pnpm exec vitest run tests/dx.test.ts tests/compiler.test.ts
pnpm exec vitest run tests/open-issues-browser.test.ts -t 'preserves template scripts'
pnpm bench:sfc | tee "benchmark/compiler/results/$TD_BENCH_RUN/after-sfc.txt"
git add src/compiler/sfc.ts tests/dx.test.ts tests/open-issues-browser.test.ts
git commit -m "fix: preserve scripts inside SFC templates"
```

### Task 3: Normalize safe HTML tree construction (Issue 009)

**Files:**
- Modify: `src/compiler/parser.ts`
- Modify: `src/compiler/ir.ts`
- Modify: `src/diagnostics.ts`
- Test: `tests/compiler.test.ts`
- Test: `tests/runtime-hydrate.test.ts`
- Test: `tests/open-issues-browser.test.ts`

- [ ] **Step 1: Record the compiler baseline**

```bash
TD_BENCH_RUN="2026-08-15-009-node-$(node -p 'process.version')"
mkdir -p "benchmark/compiler/results/$TD_BENCH_RUN"
pnpm bench:compiler | tee "benchmark/compiler/results/$TD_BENCH_RUN/before.txt"
```

- [ ] **Step 2: Write failing parser-oracle tests**

```ts
it("normalizes direct tr children to tbody", async () => {
  const fixture = await renderAndHydrate(`<table><tr><td>{value}</td></tr></table>`, { value: "A" });
  fixture.scope.value = "B";
  expect(fixture.element.querySelector("tbody td")?.textContent).toBe("B");
});

it.each([
  `<table><div>{value}</div><tr><td>x</td></tr></table>`,
  `<select><div>{value}</div></select>`,
])("reports unsupported tree construction for %s", (source) => {
  expect(() => compileTemplate(source, { target: "client" })).toThrow(/HTML tree construction/);
});
```

- [ ] **Step 3: Verify RED**

Run: `pnpm exec vitest run tests/compiler.test.ts tests/runtime-hydrate.test.ts -t 'tree construction|direct tr'`

Expected: direct rows produce the wrong runtime path and unsupported foster-parenting forms compile silently.

- [ ] **Step 4: Canonicalize bounded cases and diagnose the rest**

```ts
const normalizeTableChildren = (element: ElementNode): void => {
  if (element.tagName === "table") {
    element.children = wrapContiguousChildren(element.children, (child) => isElement(child, "tr"), "tbody");
    element.children = wrapContiguousChildren(element.children, (child) => isElement(child, "col"), "colgroup");
  }
};

const requiresBrowserFosterParenting = (element: ElementNode): boolean =>
  element.tagName === "table" && element.children.some((child) => !isAllowedTableChild(child));
```

Run normalization before path generation. Emit a positioned diagnostic for unsupported foster-parenting and invalid select content.

- [ ] **Step 5: Verify, benchmark, and commit**

```bash
pnpm exec vitest run tests/compiler.test.ts tests/runtime-hydrate.test.ts
pnpm exec vitest run tests/open-issues-browser.test.ts -t 'table tree construction'
pnpm bench:compiler | tee "benchmark/compiler/results/$TD_BENCH_RUN/after.txt"
pnpm check:size
git add src/compiler/parser.ts src/compiler/ir.ts src/diagnostics.ts tests/compiler.test.ts tests/runtime-hydrate.test.ts tests/open-issues-browser.test.ts
git commit -m "fix: normalize HTML tree construction paths"
```

### Task 4: Reject hydration metadata inside loops (Issue 010)

**Files:**
- Modify: `src/compiler/ir.ts`
- Test: `tests/compiler.test.ts`
- Modify: `docs/syntax-spec.md`

- [ ] **Step 1: Write failing diagnostics for every unsupported metadata kind**

```ts
it.each([
  `<for each={items}><div hydrate="idle">x</div></for>`,
  `<for each={items}><Widget /></for>`,
  `<for each={items}><store name="row" /></for>`,
])("rejects per-row hydration metadata in %s", (source) => {
  expect(() => compileTemplate(source, { target: "client" })).toThrow(/inside <for>/);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/compiler.test.ts -t 'per-row hydration metadata|inside <for>'`

Expected: compiler output silently drops child hydration metadata or emits duplicate IDs.

- [ ] **Step 3: Validate the child lowering result before returning a list binding**

```ts
const validateTree = (node: TemplateNode, insideFor = false): Result<void, CompilerError> => {
  if (node.type === "text") return ok(undefined);
  if (insideFor && hydrationBoundaryFor(node, [])) {
    return semanticError("Hydration boundaries inside <for> are not supported; move the boundary outside the list.", openingTagSpan(node));
  }
  if (insideFor && (node.tagName === "component" || node.tagName === "store")) {
    return semanticError(`<${node.tagName}> inside <for> is not supported because row-local metadata cannot be represented.`, openingTagSpan(node));
  }
  const childInsideFor = insideFor || node.tagName === "for";
  for (const child of node.children) {
    const result = validateTree(child, childInsideFor);
    if (!result.ok) return result;
  }
  return ok(undefined);
};
```

Call this from IR validation before target lowering. Keep normal text, event, and ref list bindings supported.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/compiler.test.ts tests/runtime-hydrate.test.ts`

Expected: all unsupported forms produce positioned errors, top-level hydration remains supported, and ordinary keyed list bindings pass.

- [ ] **Step 5: Document and commit**

```bash
git add src/compiler/ir.ts tests/compiler.test.ts docs/syntax-spec.md
git commit -m "fix: diagnose hydration metadata inside loops"
```

### Task 5: Compose dynamic base classes and directives (Issue 029)

**Files:**
- Modify: `src/compiler/types.ts`
- Modify: `src/compiler/targets/client.ts`
- Modify: `src/compiler/targets/server.ts`
- Modify: `src/runtime/class.ts`
- Test: `tests/compiler.test.ts`
- Test: `tests/open-issues-browser.test.ts`

- [ ] **Step 1: Write failing target-parity and interaction tests**

```ts
it.each(["server", "stream"] as const)("renders dynamic base class in %s", (target) => {
  expect(renderCompiled(`<div class={base} class:active={active}></div>`, target, {
    base: `card\" data-x=\"1`, active: true,
  })).toContain('class="card&amp;quot; data-x=&amp;quot;1 active"');
});

it("retains directive classes after a base class update", async () => {
  const fixture = mountCompiled(`<div class={base} class:active={active}></div>`, { base: "one", active: true });
  fixture.scope.base = "two";
  expect(fixture.element.className).toBe("two active");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/compiler.test.ts tests/open-issues-browser.test.ts -t 'dynamic base class|directive classes'`

Expected: server/stream render `{base}` literally or unsafely and client base updates remove active directive classes.

- [ ] **Step 3: Lower all class inputs into one class binding**

```ts
export type ClassBinding = {
  kind: "class";
  path: number[];
  baseExpression?: string;
  directives: Array<{ className: string; expression: string }>;
};

export const composeClassValue = (
  base: unknown,
  directives: readonly [string, unknown][],
): string => [normalizeClass(base), ...directives.filter(([, enabled]) => Boolean(enabled)).map(([name]) => name)]
  .filter(Boolean)
  .join(" ");
```

Generate one reactive client effect for the composed value and one escaped server/stream class expression. Retain static class folding when no expression exists.

- [ ] **Step 4: Verify GREEN in all targets**

```bash
pnpm exec vitest run tests/compiler.test.ts
pnpm exec vitest run tests/open-issues-browser.test.ts -t 'dynamic base class|directive classes'
pnpm check:size
```

Expected: class bytes are escaped, nullish/false/empty base values do not create malformed spacing, and independent base/directive updates preserve both sources.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/types.ts src/compiler/targets/client.ts src/compiler/targets/server.ts src/runtime/class.ts tests/compiler.test.ts tests/open-issues-browser.test.ts
git commit -m "fix: compose dynamic classes across targets"
```

### Task 6: Run compiler and browser verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run focused suites**

```bash
pnpm exec vitest run tests/compiler.test.ts tests/dx.test.ts tests/runtime-hydrate.test.ts tests/open-issues-browser.test.ts
pnpm lint
pnpm build
pnpm check:size
pnpm check:browser-entry
```

Expected: every command exits 0 and Playwright closes Chromium in `afterAll`.

- [ ] **Step 2: Check browser process cleanup**

```bash
ps -eo pid=,ppid=,comm=,args= | rg 'chrome-headless|playwright' || true
```

Expected: no process started by the focused browser suite remains.
