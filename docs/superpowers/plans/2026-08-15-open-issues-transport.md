# Open Issue Transport and Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issues 007, 008, and 015 by preserving native Response semantics, normalizing bodyless statuses, and publishing static dispatch precedence.

**Architecture:** The router core retains a native web `Response` instead of decoding it into `responseBody`. Adapters remain responsible for their existing byte-safe terminal conversion. Bodyless status normalization happens once at the router result boundary, while static route and asset order remains unchanged and becomes an explicit contract.

**Tech Stack:** TypeScript, Web Response/ReadableStream, node:http, Vitest, Workers/Node/Lambda adapters.

---

### Task 1: Preserve middleware Response bytes (Issue 007)

**Files:**
- Modify: `src/router.ts`
- Modify: `src/adapters/workers.ts`
- Test: `tests/router-security.test.ts`
- Test: `tests/router-adapters.test.ts`
- Modify: `docs/routing.md`

- [ ] **Step 1: Write the failing core and adapter byte tests**

```ts
const binaryBody = Uint8Array.from([0, 255, 254, 195, 40, 137, 80, 78, 71]);

it.each(["workers", "node", "lambda", "lambda-stream"] as const)(
  "preserves middleware bytes in %s",
  async (adapter) => {
    const response = await invokeAdapter(adapter, () =>
      new Response(binaryBody, { status: 206, headers: { "content-type": "application/octet-stream", "x-binary": "yes" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("x-binary")).toBe("yes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(binaryBody);
  },
);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/router-security.test.ts tests/router-adapters.test.ts -t 'preserves middleware bytes'`

Expected: at least one byte differs after `.text()` decoding and re-encoding.

- [ ] **Step 3: Add native Response ownership to router results**

```ts
export type RouteRenderResult = {
  status: number;
  headers: Headers;
  html: string;
  responseBody?: string;
  webResponse?: Response;
};

const webResponseResult = (response: Response): RouteRenderResult => ({
  status: response.status,
  headers: new Headers(response.headers),
  html: "",
  webResponse: response,
});
```

Do not call `response.text()`. If `webResponse` is set, skip HTML streaming and return it from the Workers handler; Node and Lambda continue through their existing Response converters.

- [ ] **Step 4: Verify GREEN and text compatibility**

Run: `pnpm exec vitest run tests/router-security.test.ts tests/router-adapters.test.ts`

Expected: binary byte equality passes for every adapter and existing ASCII terminal middleware responses retain status, headers, and text.

- [ ] **Step 5: Document and commit**

```bash
git add src/router.ts src/adapters/workers.ts tests/router-security.test.ts tests/router-adapters.test.ts docs/routing.md
git commit -m "fix: preserve middleware response bytes"
```

### Task 2: Normalize bodyless statuses and guard Node failures (Issue 008)

**Files:**
- Modify: `src/router.ts`
- Modify: `src/adapters/node.ts`
- Test: `tests/router-advanced.test.ts`
- Test: `tests/router-adapters.test.ts`

- [ ] **Step 1: Write the failing status matrix**

```ts
it.each([204, 205, 304])("removes bodies and transfer headers for status %i", async (status) => {
  const response = await invokeRoute(() => routeResponse("unexpected", {
    status,
    headers: { "content-length": "10", "transfer-encoding": "chunked", "x-kept": "yes" },
  }));
  expect(response.status).toBe(status);
  expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(0);
  expect(response.headers.get("content-length")).toBeNull();
  expect(response.headers.get("transfer-encoding")).toBeNull();
  expect(response.headers.get("x-kept")).toBe("yes");
});
```

Add a real Node handler case where an unexpected pre-header failure produces status 500 and no `unhandledRejection` event.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run tests/router-advanced.test.ts tests/router-adapters.test.ts -t 'bodyless status|unexpected Node handler'`

Expected: constructing a Response with a body and 204, 205, or 304 throws outside the intended route contract.

- [ ] **Step 3: Normalize at the router result boundary**

```ts
const bodylessStatuses = new Set([204, 205, 304]);

const normalizeRouteResult = (result: RouteRenderResult): RouteRenderResult => {
  if (!bodylessStatuses.has(result.status)) return result;
  const headers = new Headers(result.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return { ...result, headers, html: "", responseBody: undefined, webResponse: undefined };
};
```

Wrap the Node handler await in one top-level `try/catch`. Before headers are sent, write a generic 500 response with the configured security headers; after sending starts, destroy only that response stream or socket.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run tests/router-advanced.test.ts tests/router-adapters.test.ts`

Expected: all bodyless combinations return empty bodies without adapter exceptions, normal status bodies remain unchanged, and unexpected Node failures are contained.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/adapters/node.ts tests/router-advanced.test.ts tests/router-adapters.test.ts
git commit -m "fix: normalize bodyless route responses"
```

### Task 3: Publish static dispatch precedence (Issue 015)

**Files:**
- Test: `tests/router-adapters.test.ts`
- Test: `tests/router-security.test.ts`
- Modify: `docs/routing.md`

- [ ] **Step 1: Write the failing or absent precedence matrix**

```ts
it.each(["workers", "node", "lambda"] as const)(
  "documents static dispatch before route middleware in %s",
  async (adapter) => {
    const calls: string[] = [];
    const result = await requestStaticMatrix(adapter, {
      middleware: () => { calls.push("middleware"); return new Response("denied", { status: 403 }); },
    });
    expect(result.staticRoute.status).toBe(200);
    expect(result.asset.status).toBe(200);
    expect(result.assetMiss.status).toBe(403);
    expect(calls).toEqual(["middleware"]);
  },
);

it("documents that route middleware does not authorize static assets", async () => {
  const routing = await readFile("docs/routing.md", "utf8");
  expect(routing).toContain("static routes and assets are resolved before route middleware");
  expect(routing).toContain("route middleware must not be used to authorize static content");
});
```

- [ ] **Step 2: Run the test and classify the RED state**

Run: `pnpm exec vitest run tests/router-adapters.test.ts tests/router-security.test.ts -t 'static dispatch before route middleware'`

Expected: the documentation assertion fails because the static-content authorization boundary is not documented. The adapter assertions record the already-observed production order without changing it.

- [ ] **Step 3: Add the dispatch diagram and trust-boundary text**

```text
request
  -> configured static route
  -> configured asset source
  -> route matching and route middleware
  -> NotFound
```

Document that route middleware is not authorization for static routes or assets and that protected content must not be placed in the pre-route static sources.

- [ ] **Step 4: Verify adapter parity**

Run: `pnpm exec vitest run tests/router-adapters.test.ts tests/router-security.test.ts`

Expected: Workers, Node, and Lambda preserve the documented order; asset 404 falls through once and security headers remain on short circuits.

- [ ] **Step 5: Commit**

```bash
git add tests/router-adapters.test.ts tests/router-security.test.ts docs/routing.md
git commit -m "docs: define static asset dispatch boundary"
```

### Task 4: Run transport verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run focused tests and common gates**

```bash
pnpm exec vitest run tests/router-security.test.ts tests/router-advanced.test.ts tests/router-adapters.test.ts
pnpm lint
pnpm build
pnpm check:browser-entry
```

Expected: all commands exit 0 and the adapter tests report no leaked rejection or byte mismatch.
