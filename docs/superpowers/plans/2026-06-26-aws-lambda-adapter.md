# AWS Lambda Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Lambda adapter for Tachyon DOM SSR, including buffered Lambda proxy responses and Lambda response streaming support.

**Architecture:** Implement `src/adapters/lambda.ts` as a platform boundary around the existing Web-standard Workers handler. Tests drive conversion between Lambda payload format v2.0 events, Web `Request`/`Response`, buffered Lambda proxy responses, and response streaming writes.

**Tech Stack:** TypeScript, Web `Request`/`Response`, AWS Lambda Node response streaming runtime, Vitest.

---

### Task 1: Buffered Lambda Event and Response Conversion

**Files:**
- Create: `src/adapters/lambda.ts`
- Modify: `tests/router-adapters.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests**

Add tests that import `createLambdaHandler`, `requestFromLambdaEvent`, and `lambdaResponseFromWebResponse` from `../src/adapters/lambda`. Cover a `POST /submit?debug=1` event with cookies and a text body, a route render with security headers, `Set-Cookie` extraction, and binary response base64 encoding.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run tests/router-adapters.test.ts`

Expected: fail with a missing `../src/adapters/lambda` module or missing exported functions.

- [ ] **Step 3: Implement minimal buffered adapter**

Create `src/adapters/lambda.ts` with:

- `LambdaHttpEventV2`
- `LambdaProxyResponseV2`
- `LambdaHandlerOptions`
- `requestFromLambdaEvent(event, options?)`
- `lambdaResponseFromWebResponse(response)`
- `createLambdaHandler(options)`

Add `./adapters/lambda` to `package.json` exports.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run tests/router-adapters.test.ts`

Expected: all router adapter tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/adapters/lambda.ts tests/router-adapters.test.ts package.json
git commit -m "feat: add aws lambda buffered adapter"
```

### Task 2: Lambda Response Streaming

**Files:**
- Modify: `src/adapters/lambda.ts`
- Modify: `tests/router-adapters.test.ts`

- [ ] **Step 1: Write failing streaming test**

Add a test for `createLambdaStreamingHandler({ routes, streaming: true }, runtime)`. The fake runtime must capture the inner handler, wrap the stream with `HttpResponseStream.from()`, record metadata, and collect written chunks.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run tests/router-adapters.test.ts`

Expected: fail because `createLambdaStreamingHandler` or streaming helpers are missing.

- [ ] **Step 3: Implement streaming adapter**

Add:

- `LambdaResponseStream`
- `LambdaStreamingRuntime`
- `writeWebResponseToLambdaStream(response, responseStream, runtime)`
- `createLambdaStreamingHandler(options, runtime?)`

The default runtime reads `globalThis.awslambda`. If it is absent, throw a clear error explaining that the handler must run in the AWS Lambda Node runtime or receive a runtime adapter.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run tests/router-adapters.test.ts`

Expected: all router adapter tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/adapters/lambda.ts tests/router-adapters.test.ts
git commit -m "feat: add aws lambda streaming adapter"
```

### Task 3: Compatibility Exports and Documentation

**Files:**
- Modify: `src/adapters.ts`
- Modify: `docs/routing.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing compatibility test**

Add a test that imports `createLambdaHandler` from `../src/adapters` and verifies a simple route response.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run tests/router-compatibility.test.ts`

Expected: fail because the compatibility export is missing.

- [ ] **Step 3: Add exports and docs**

Re-export Lambda adapter symbols from `src/adapters.ts`. Document `tachyon-dom/adapters/lambda`, Function URL/API Gateway HTTP API v2 support, streaming requirements, and static asset guidance in `docs/routing.md` and update the README adapter summary.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run tests/router-compatibility.test.ts tests/router-adapters.test.ts`

Expected: selected tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/adapters.ts docs/routing.md README.md tests/router-compatibility.test.ts
git commit -m "docs: document aws lambda adapter"
```

### Task 4: Security Review and Final Verification

**Files:**
- Modify as needed based on review.
- Update: `docs.local/logs/2026-06-26/2026-06-26-007-aws-lambda-adapter.md`

- [ ] **Step 1: Request Security Specialist review**

Ask the Security Specialist agent to review Lambda event conversion, origin handling, header/cookie handling, body decoding, and streaming metadata.

- [ ] **Step 2: Fix Must Fix findings**

If the review reports Must Fix items, add a failing regression test first, implement the fix, and rerun the targeted tests.

- [ ] **Step 3: Run final verification**

Run:

```bash
pnpm vitest run tests/router-adapters.test.ts tests/router-compatibility.test.ts tests/router-platform.test.ts
pnpm build
pnpm lint
```

Expected: all commands pass.

- [ ] **Step 4: Commit final fixes**

Commit any review fixes, docs, and log updates with a focused message.
