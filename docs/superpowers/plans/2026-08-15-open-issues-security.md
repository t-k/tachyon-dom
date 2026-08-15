# Open Issue Security Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issues 002, 004, 005, 006, 013, 014, 016, and 019 with context-aware validation and parser-backed security regression coverage.

**Architecture:** Introduce small shared policy primitives for dangerous attributes and URL canonicalization, while keeping raw-text, proxy, cookie, and source-map decisions at their existing ownership boundaries. Compiler, direct HTML, router, and adapter paths consume the same corpora but retain context-specific allowlists.

**Tech Stack:** TypeScript, Vitest, parse5/jsdom, Playwright, Tachyon DOM compiler/server/router.

---

### Task 1: Reject dynamic raw-text interpolation (Issue 002)

**Files:**
- Modify: `src/compiler/ir.ts`
- Modify: `src/diagnostics.ts`
- Test: `tests/compiler.test.ts`
- Test: `tests/dx.test.ts`

- [ ] **Step 1: Write the failing compiler tests**

Add table-driven cases that compile `script` and `style` with ordinary expressions and assert a positioned diagnostic, while static content and `textarea`/`title` retain their existing behavior.

```ts
it.each(["script", "style"])("rejects expressions inside %s raw text", (tag) => {
  expect(() => compileTemplate(`<${tag}>{payload}</${tag}>`, { target: "server" })).toThrow(
    /Expressions inside <(?:script|style)> are not supported/,
  );
});

it("preserves static raw text and RCDATA escaping", () => {
  expect(renderTemplate(`<script>const x = "<&";</script>`, {})).toContain('const x = "<&";');
  expect(renderTemplate(`<textarea>{value}</textarea>`, { value: "<&" })).toContain("&lt;&amp;");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/compiler.test.ts tests/dx.test.ts -t 'raw text|RCDATA'`

Expected: the dynamic `script` and `style` cases fail because compilation currently succeeds.

- [ ] **Step 3: Add the common IR diagnostic**

Validate before target lowering so client, server, and stream receive the same result.

```ts
const expressionForbiddenChildTags = new Set(["script", "style"]);

const validateRawTextExpressions = (element: ElementNode): Result<void, CompilerError> => {
  if (!expressionForbiddenChildTags.has(element.tagName.toLowerCase())) return ok(undefined);
  for (const child of element.children) {
    if (child.type !== "text") continue;
    const expression = textExpressionSegments(child.value).find((segment) => segment.kind === "expression");
    if (expression) {
      return semanticError(
        `Expressions inside <${element.tagName}> are not supported; serialize data outside raw text.`,
        { start: (child.start ?? 0) + expression.start, end: (child.start ?? 0) + expression.end },
      );
    }
  }
  return ok(undefined);
};
```

- [ ] **Step 4: Verify GREEN and target parity**

Run: `pnpm exec vitest run tests/compiler.test.ts tests/dx.test.ts`

Expected: both files pass and static raw text remains byte-for-byte unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/ir.ts src/diagnostics.ts tests/compiler.test.ts tests/dx.test.ts
git commit -m "fix: reject unsafe raw text interpolation"
```

### Task 2: Validate trusted forwarded protocols (Issue 004)

**Files:**
- Modify: `src/adapters/node.ts`
- Test: `tests/router-adapters.test.ts`
- Modify: `docs/routing.md`

- [ ] **Step 1: Write the failing Node adapter matrix**

Use a real `node:http` request and assert that valid single values work, `trustProxy:false` ignores the header, and invalid or multi-valued values return 400 without changing the requested path.

```ts
it.each(["", "javascript", "file", "https://evil.test/#", "http,https"])(
  "returns 400 for forwarded protocol %j",
  async (protocol) => {
    const response = await requestNodeHandler({ path: "/admin", headers: { "x-forwarded-proto": protocol } });
    expect(response.status).toBe(400);
    expect(seenRouteIds).toEqual([]);
  },
);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/router-adapters.test.ts -t 'forwarded protocol'`

Expected: invalid values do not produce the required 400 contract.

- [ ] **Step 3: Add an allowlisted parser**

```ts
const forwardedProtocol = (value: string | string[] | undefined): "http" | "https" | Response => {
  if (typeof value !== "string" || value.includes(",")) {
    return new Response("Bad Request", { status: 400 });
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "http" || normalized === "https"
    ? normalized
    : new Response("Bad Request", { status: 400 });
};
```

Call it only when `trustProxy` is true. Keep `options.origin` authoritative and do not inspect the header when proxy trust is disabled.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/router-adapters.test.ts -t 'forwarded protocol|trusted proxy'`

Expected: the invalid matrix returns 400, normal `http`/`https` routing passes, and the route path remains `/admin`.

- [ ] **Step 5: Document and commit**

```bash
git add src/adapters/node.ts tests/router-adapters.test.ts docs/routing.md
git commit -m "fix: validate trusted forwarded protocols"
```

### Task 3: Track direct HTML attribute context (Issue 005)

**Files:**
- Modify: `src/server/html.ts`
- Test: `tests/server-html.test.ts`
- Create: `benchmark/server-html.ts`

- [ ] **Step 1: Record the baseline**

Create the benchmark harness before changing `src/server/html.ts`.

```ts
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { html } from "../src/server/html";

const values = Array.from({ length: 1_000 }, (_, index) => `asset-${index}`);
const iterations = 200;
for (let warmup = 0; warmup < 20; warmup++) values.forEach((value) => String(html`<img src=${value}>`));
const started = performance.now();
for (let iteration = 0; iteration < iterations; iteration++) {
  values.forEach((value) => String(html`<img src=${value}>`));
}
const durationMs = performance.now() - started;
console.log(JSON.stringify({
  node: process.version,
  corpusHash: createHash("sha256").update(values.join("\n")).digest("hex"),
  iterations,
  operationsPerSecond: (values.length * iterations * 1_000) / durationMs,
}));
```

```bash
TD_BENCH_RUN="2026-08-15-005-node-$(node -p 'process.version')"
mkdir -p "benchmark/server-html/results/$TD_BENCH_RUN"
pnpm exec tsx benchmark/server-html.ts | tee "benchmark/server-html/results/$TD_BENCH_RUN/before.txt"
```

Expected: the output records Node, corpus hash, iterations, and operations per second.

- [ ] **Step 2: Write parser-oracle RED tests**

```ts
it.each([" ", "\t", "\n", "=", "`", '"', "'"])(
  "rejects interpolation inside an unquoted attribute containing %j",
  (token) => {
    expect(() => html`<img src=/asset/${`x${token}onerror=alert(1)`}.png>`).toThrow(
      /unquoted attribute value/,
    );
  },
);

it("keeps direct attributes automatically quoted", () => {
  const document = parse(html`<input value=${"a b"}>`);
  expect(document.querySelector("input")?.getAttributeNames()).toEqual(["value"]);
  expect(document.querySelector("input")?.getAttribute("value")).toBe("a b");
});
```

- [ ] **Step 3: Verify RED**

Run: `pnpm exec vitest run tests/server-html.test.ts -t 'unquoted attribute|automatically quoted'`

Expected: prefix/suffix unquoted cases render instead of throwing.

- [ ] **Step 4: Replace the previous-literal regex with state tracking**

```ts
type HtmlInterpolationContext =
  | { kind: "text" }
  | { kind: "attribute-boundary"; name: string }
  | { kind: "quoted-attribute"; quote: '"' | "'" }
  | { kind: "unquoted-attribute" };

const renderInterpolation = (context: HtmlInterpolationContext, value: unknown): string => {
  if (context.kind === "unquoted-attribute") {
    throw new TypeError("Interpolation inside an unquoted attribute value is not supported; quote the value");
  }
  if (context.kind === "attribute-boundary") return `"${renderAttributeValue(value)}"`;
  if (isHtmlFragment(value) || isHtmlAttribute(value)) assertBrandContext(context, value);
  return context.kind === "text" ? renderTextValue(value) : renderAttributeValue(value);
};
```

Scan literal chunks in order so the context entering each interpolation includes every preceding chunk and interpolation.

- [ ] **Step 5: Verify GREEN, benchmark, and commit**

```bash
pnpm exec vitest run tests/server-html.test.ts
pnpm exec tsx benchmark/server-html.ts | tee "benchmark/server-html/results/$TD_BENCH_RUN/after.txt"
git add src/server/html.ts tests/server-html.test.ts benchmark/server-html.ts
git commit -m "fix: reject unsafe unquoted HTML interpolation"
```

### Task 4: Merge cookie defaults and enforce prefixes (Issue 006)

**Files:**
- Modify: `src/cookies.ts`
- Test: `tests/router-security.test.ts`
- Modify: `docs/routing.md`

- [ ] **Step 1: Write failing storage matrices**

```ts
it.each(["memory", "signed"] as const)("merges secure defaults for %s sessions", async (kind) => {
  const storage = createStorage(kind, { cookie: { maxAge: 60 } });
  const committed = await storage.commitSession(await storage.getSession());
  const destroyed = await storage.destroySession(await storage.getSession());
  for (const value of [committed, destroyed]) {
    expect(value).toContain("Path=/");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("Secure");
    expect(value).toContain("SameSite=Lax");
  }
});

it("rejects insecure __Host- cookie configuration", () => {
  expect(() => createSignedCookieSessionStorage({ cookie: { secure: false } })).toThrow(/__Host-/);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/router-security.test.ts -t 'merges secure defaults|__Host-'`

Expected: partial options remove defaults and invalid prefix options are accepted.

- [ ] **Step 3: Merge and validate once at storage creation**

```ts
const resolveSessionCookie = (name: string, overrides: CookieOptions | undefined): CookieOptions => {
  const resolved = { ...defaultSessionCookie(), ...overrides };
  if (name.startsWith("__Host-") && (!resolved.secure || resolved.path !== "/" || resolved.domain)) {
    throw new TypeError("__Host- cookies require Secure, Path=/, and no Domain");
  }
  if (name.startsWith("__Secure-") && !resolved.secure) {
    throw new TypeError("__Secure- cookies require Secure");
  }
  return resolved;
};
```

Use the resolved object for both commit and destroy; destroy changes only `maxAge`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/router-security.test.ts`

Expected: memory and signed storage pass for commit, destroy, explicit strict SameSite, and allowed prefix-free `secure:false`.

- [ ] **Step 5: Document and commit**

```bash
git add src/cookies.ts tests/router-security.test.ts docs/routing.md
git commit -m "fix: preserve secure session cookie defaults"
```

### Task 5: Share dangerous attribute policy (Issue 013)

**Files:**
- Create: `src/attribute-policy.ts`
- Modify: `src/runtime/attr.ts`
- Modify: `src/compiler/ir.ts`
- Modify: `src/server/html.ts`
- Test: `tests/compiler.test.ts`
- Test: `tests/runtime-attr-form.test.ts`
- Test: `tests/server-html.test.ts`

- [ ] **Step 1: Write failing target-parity tests**

```ts
const dangerousNames = ["onclick", "ONLOAD", "srcdoc", "innerhtml", "outerhtml"];

it.each(dangerousNames)("rejects dangerous attribute %s in every compiler target", (name) => {
  const source = `<iframe ${name}={value}></iframe>`;
  for (const target of ["client", "server", "stream"] as const) {
    expect(() => compileTemplate(source, { target })).toThrow(/dangerous attribute/i);
  }
});

it.each(dangerousNames)("rejects direct HTML attribute %s", (name) => {
  expect(() => attr(name, "value")).toThrow(/dangerous attribute/i);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/compiler.test.ts tests/runtime-attr-form.test.ts tests/server-html.test.ts -t 'dangerous attribute'`

Expected: server, stream, static compiler attributes, and direct `attr()` accept at least one dangerous name.

- [ ] **Step 3: Add and consume the shared name policy**

```ts
const fixedDangerousAttributeNames = new Set(["srcdoc", "innerhtml", "outerhtml"]);

export const isDangerousAttributeName = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return normalized.startsWith("on") || fixedDangerousAttributeNames.has(normalized);
};

export const validateAttributeName = (name: string): Result<string, TypeError> =>
  isDangerousAttributeName(name)
    ? err(new TypeError(`Dangerous attribute is not supported: ${name}`))
    : ok(name);
```

Call the same predicate from compiler IR validation, the runtime setter, and direct HTML attribute construction. Compiler validation covers static and dynamic forms before target lowering.

- [ ] **Step 4: Verify GREEN and normal attributes**

Run: `pnpm exec vitest run tests/compiler.test.ts tests/runtime-attr-form.test.ts tests/server-html.test.ts`

Expected: all dangerous-name matrices fail closed and `data-*`, `aria-*`, `class`, and normal form attributes remain supported.

- [ ] **Step 5: Commit**

```bash
git add src/attribute-policy.ts src/runtime/attr.ts src/compiler/ir.ts src/server/html.ts tests/compiler.test.ts tests/runtime-attr-form.test.ts tests/server-html.test.ts
git commit -m "fix: reject dangerous attributes across targets"
```

### Task 6: Add contextual URL policy (Issue 014)

**Files:**
- Create: `src/url-policy.ts`
- Modify: `src/security.ts`
- Modify: `src/router.ts`
- Modify: `src/runtime/attr.ts`
- Modify: `src/compiler/ir.ts`
- Modify: `src/server/html.ts`
- Modify: `src/index.ts`
- Test: `tests/router-security.test.ts`
- Test: `tests/server-html.test.ts`
- Test: `tests/compiler.test.ts`
- Test: `tests/public-api.test.ts`

- [ ] **Step 1: Write one shared failing corpus**

```ts
const activeUrlCorpus = [
  "javascript:alert(1)",
  " JAVASCRIPT:alert(1)",
  "java\tscript:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
];

it.each(activeUrlCorpus)("rejects active URL %j across protected APIs", (value) => {
  const context = { element: "a", attribute: "href", purpose: "document-navigation" } as const;
  expect(sanitizeUrlAttribute({ ...context, value }).ok).toBe(false);
  expect(() => attr("href", value)).toThrow(/unsafe URL/i);
  expect(() => compileTemplate(`<a href=${JSON.stringify(value)}>x</a>`, { target: "server" })).toThrow(
    /unsafe URL/i,
  );
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/server-html.test.ts tests/compiler.test.ts tests/router-security.test.ts tests/public-api.test.ts -t 'active URL|URL policy'`

Expected: low-level attr and compiler paths accept the active-scheme corpus and the public contextual API does not exist.

- [ ] **Step 3: Implement canonicalization plus purpose-specific allowlists**

```ts
export type UrlAttributeContext = {
  element: string;
  attribute: "href" | "src" | "action" | "formaction" | "xlink:href";
  purpose: "document-navigation" | "subresource" | "form-submission";
  allowedOrigins?: readonly string[];
  value: string;
};

export const sanitizeUrlAttribute = (context: UrlAttributeContext): Result<string, UnsafeUrlError> => {
  const normalized = stripAsciiControls(context.value).trim();
  const parsed = parseUrlReference(normalized);
  return allowsUrlForPurpose(parsed, context)
    ? ok(normalized)
    : err(new UnsafeUrlError(context.attribute));
};
```

Reuse `stripAsciiControls`, parsing, and scheme classification from `sanitizeHtml`, `renderHead`, and `redirect`, but keep their origin and purpose policies separate. Apply compiler checks to literal URLs and runtime checks to dynamic values.

- [ ] **Step 4: Verify GREEN and target parity**

Run: `pnpm exec vitest run tests/server-html.test.ts tests/compiler.test.ts tests/router-security.test.ts tests/public-api.test.ts`

Expected: relative, HTTPS, mailto, and tel pass in documented contexts; active schemes fail in all protected paths; redirect origin restrictions remain intact.

- [ ] **Step 5: Export, size-check, and commit**

```bash
pnpm build
pnpm check:exports
pnpm check:size
git add src/url-policy.ts src/security.ts src/router.ts src/runtime/attr.ts src/compiler/ir.ts src/server/html.ts src/index.ts tests/server-html.test.ts tests/compiler.test.ts tests/router-security.test.ts tests/public-api.test.ts
git commit -m "fix: apply contextual URL safety policy"
```

### Task 7: Disable production inline source maps by default (Issue 016)

**Files:**
- Modify: `src/vite.ts`
- Modify: `src/source-map.ts`
- Test: `tests/dx.test.ts`
- Modify: `docs/app-vite.md`

- [ ] **Step 1: Write the failing precedence matrix**

```ts
it.each([
  [{ command: "build", mode: "production" }, {}, false],
  [{ command: "serve", mode: "development" }, {}, true],
  [{ command: "build", mode: "production" }, { sourcemap: true }, true],
  [{ command: "serve", mode: "development" }, { sourcemap: false }, false],
] as const)("resolves source-map defaults for %o", (config, options, expected) => {
  expect(shouldEmitPluginSourceMap(config, options)).toBe(expected);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/dx.test.ts -t 'source-map defaults|production source'`

Expected: production default emits an inline source map.

- [ ] **Step 3: Implement explicit precedence**

```ts
export const shouldEmitSourceMap = (context: SourceMapBuildContext = {}): boolean => {
  if (context.sourcemap !== undefined) return context.sourcemap;
  if (context.command === "build" && context.mode === "production") {
    return context.productionSourceMap === true;
  }
  return true;
};
```

Keep `onSourceMap` invocation independent so a trusted local uploader can receive a map without embedding it in output.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/dx.test.ts -t 'source map|source-map'`

Expected: production output omits `sourceMappingURL=data:`, development and explicit opt-in include it, and `onSourceMap` still runs.

- [ ] **Step 5: Document and commit**

```bash
git add src/source-map.ts src/vite.ts tests/dx.test.ts docs/app-vite.md
git commit -m "fix: disable production inline source maps by default"
```

### Task 8: Preserve malformed-path 400 responses (Issue 019)

**Files:**
- Modify: `src/router.ts`
- Test: `tests/router-advanced.test.ts`
- Test: `tests/router-adapters.test.ts`

- [ ] **Step 1: Write failing route and adapter tests**

```ts
it.each(["/items/%", "/items/%zz", "/items/%E0%A4%A"])(
  "returns generic 400 for malformed path %s",
  async (pathname) => {
    const response = await requestRoute(pathname);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("<h1>Bad Request</h1>");
    expect(notFoundCalls).toBe(0);
  },
);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/router-advanced.test.ts tests/router-adapters.test.ts -t 'malformed path|invalid encoding'`

Expected: render flow converts the matcher's 400 result to 404.

- [ ] **Step 3: Return a generic 400 before NotFound handling**

```ts
if (!match.ok && match.error.status === 400) {
  return routeResponseResult(routeResponse("<h1>Bad Request</h1>", { status: 400 }));
}
if (!match.ok) {
  return renderNotFound(requestContext);
}
```

Keep decoding detail in internal error reporting only; do not interpolate the path or exception into public HTML.

- [ ] **Step 4: Verify GREEN and adapter parity**

Run: `pnpm exec vitest run tests/router-advanced.test.ts tests/router-adapters.test.ts tests/router-server.test.ts`

Expected: malformed encodings are 400 in core, Workers, Node, and Lambda; normal misses and custom NotFound remain 404.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts tests/router-advanced.test.ts tests/router-adapters.test.ts
git commit -m "fix: preserve invalid path encoding status"
```

### Task 9: Run the security wave review

**Files:**
- Create outside the committed source tree: `/home/tk/work/tachyon-dom/docs.local/logs/2026-08-15/security-open-issues-review.md`

- [ ] **Step 1: Run focused and common gates**

```bash
pnpm exec vitest run tests/compiler.test.ts tests/dx.test.ts tests/server-html.test.ts tests/runtime-attr-form.test.ts tests/router-security.test.ts tests/router-adapters.test.ts tests/router-advanced.test.ts tests/router-server.test.ts tests/public-api.test.ts
pnpm lint
pnpm build
pnpm check:exports
pnpm check:size
```

Expected: every command exits 0.

- [ ] **Step 2: Request the review**

Provide the diff and test evidence to the Security Specialist-compatible reviewer. Require output headings `Must Fix`, `Should Fix`, and `Notes`.

- [ ] **Step 3: Resolve review blockers**

For each Must Fix, add a focused failing regression, verify RED, implement the smallest fix, verify GREEN, and commit with `fix: address security review finding`.
