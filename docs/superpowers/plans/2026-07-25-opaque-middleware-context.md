# Opaque Middleware Authorization Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `requireUser()` wrappers preserve router-issued authorization state by type and fail closed at runtime when a wrapper reconstructs the middleware context.

**Architecture:** Export a `RouteMiddlewareContext` whose required property is keyed by a module-private `unique symbol`, then use that type for platform-neutral and Workers middleware. The router remains the only runtime issuer of the carrier, `requireUser()` validates it before identity lookup, and package-level consumer fixtures prove the generated declarations preserve the contract.

**Tech Stack:** TypeScript 5, Web `Request`/`Response`, Vitest, pnpm package verification, OxLint.

---

## File map

- Create `tests/middleware-context-types.ts`: source-tree positive and negative type contracts for platform-neutral and Workers middleware wrappers.
- Create `scripts/verify-middleware-context-types.mjs`: packed-package consumer compilation against generated declarations.
- Modify `package.json`: run the packed middleware context verifier as part of `verify:package`.
- Modify `src/router.ts`: define the opaque context carrier, expose `RouteMiddlewareContext`, validate the carrier in `requireUser()`, and keep authorization state request-local.
- Modify `src/adapters/workers.ts`: derive Workers middleware context from `RouteMiddlewareContext` while preserving typed bindings.
- Modify `tests/router-security.test.ts`: reproduce cast-based manual reconstruction and prove fail-closed ordering.
- Modify `docs/routing.md`: document the compile-time and runtime contract for wrapped guards.
- Create `docs.local/logs/2026-07-25/2026-07-25-008-opaque-middleware-context-fix.md`: ignored Japanese work log with commits, test results, reviews, process state, and merge/push status.

### Task 1: Add failing source and packed-package type contracts

**Files:**

- Create: `tests/middleware-context-types.ts`
- Create: `scripts/verify-middleware-context-types.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the source-tree type contract**

Create `tests/middleware-context-types.ts`:

```ts
import { createWorkersHandler, type WorkersRouteMiddleware } from "../src/adapters/workers";
import { requireUser, type RouteDefinition, type RouteMiddleware } from "../src/router";

const guard = requireUser(() => ({ id: "user" }));

const platformMiddleware: RouteMiddleware = (context) => {
  void guard({ ...context, request: context.request.clone() });
  const { request, url, env } = context;
  // @ts-expect-error A guard context must retain the router-issued opaque carrier.
  return guard({ request: request.clone(), url: new URL(url), env });
};

type Bindings = {
  KV: { get: (key: string) => Promise<string> };
};

const workersGuard: WorkersRouteMiddleware<Bindings> = guard;
const workersMiddleware: WorkersRouteMiddleware<Bindings> = (context) => {
  void context.bindings.KV.get("session");
  void workersGuard({ ...context, request: context.request.clone() });
  const { request, url, env, bindings } = context;
  // @ts-expect-error Named public fields cannot reconstruct the opaque Workers middleware context.
  return workersGuard({ request: request.clone(), url: new URL(url), env, bindings });
};

const routes: RouteDefinition[] = [{ path: "/", render: () => "ok" }];

createWorkersHandler<Bindings>({
  routes,
  middleware: [workersMiddleware],
});

void platformMiddleware;
```

- [ ] **Step 2: Run the source type contract and observe the intended red state**

Run:

```bash
pnpm build
```

Expected: TypeScript fails with unused `@ts-expect-error` diagnostics in `tests/middleware-context-types.ts`, proving manual reconstruction is still accepted by the current public types.

- [ ] **Step 3: Add a packed-package consumer verifier**

Create `scripts/verify-middleware-context-types.mjs`:

```js
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), "tachyon-middleware-context-package-"));
const consumer = path.join(directory, "consumer");

const source = `
import { createWorkersHandler, type WorkersRouteMiddleware } from "tachyon-dom/adapters/workers";
import { requireUser, type RouteDefinition, type RouteMiddleware } from "tachyon-dom/router";

const guard = requireUser(() => ({ id: "user" }));

const platformMiddleware: RouteMiddleware = (context) => {
  void guard({ ...context, request: context.request.clone() });
  const { request, url, env } = context;
  // @ts-expect-error A guard context must retain the router-issued opaque carrier.
  return guard({ request: request.clone(), url: new URL(url), env });
};

type Bindings = {
  KV: { get: (key: string) => Promise<string> };
};

const workersGuard: WorkersRouteMiddleware<Bindings> = guard;
const workersMiddleware: WorkersRouteMiddleware<Bindings> = (context) => {
  void context.bindings.KV.get("session");
  void workersGuard({ ...context, request: context.request.clone() });
  const { request, url, env, bindings } = context;
  // @ts-expect-error Named public fields cannot reconstruct the opaque Workers middleware context.
  return workersGuard({ request: request.clone(), url: new URL(url), env, bindings });
};

const routes: RouteDefinition[] = [{ path: "/", render: () => "ok" }];
createWorkersHandler<Bindings>({ routes, middleware: [workersMiddleware] });
void platformMiddleware;
`;

try {
  await execFileAsync("pnpm", ["pack", "--pack-destination", directory], { cwd: projectRoot });
  const tarballName = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not create a tarball.");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  await execFileAsync("pnpm", ["add", "--ignore-workspace", path.join(directory, tarballName)], { cwd: consumer });
  const usageFile = path.join(consumer, "usage.ts");
  await writeFile(usageFile, source);
  const installedRoot = await realpath(path.join(consumer, "node_modules/tachyon-dom"));
  if (installedRoot.startsWith(projectRoot)) {
    throw new Error("Type probe resolved the workspace instead of the packed package.");
  }
  const program = ts.createProgram([usageFile], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"),
    );
  }
  console.log(`Installed package middleware context declarations verified from ${installedRoot}.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

- [ ] **Step 4: Add the package verification gate**

Change the `verify:package` script in `package.json` to:

```json
"verify:package": "node scripts/verify-package-artifacts.mjs && node scripts/verify-middleware-context-types.mjs"
```

This reuses the existing CI and release workflow gate without duplicating workflow steps.

### Task 2: Brand platform-neutral and Workers middleware contexts

**Files:**

- Modify: `src/router.ts:172-199`
- Modify: `src/router.ts:614-623`
- Modify: `src/router.ts:1302-1315`
- Modify: `src/adapters/workers.ts:1-15`
- Modify: `src/adapters/workers.ts:129-134`
- Test: `tests/middleware-context-types.ts`
- Test: `scripts/verify-middleware-context-types.mjs`

- [ ] **Step 1: Define the carrier and exported middleware context**

Move the authorization state declarations before `RouteMiddleware` and replace the inline context type in `src/router.ts` with:

```ts
const userGuardAuthorizationState: unique symbol = Symbol("tachyon.userGuardAuthorizationState");

type UserGuardAuthorizationState = {
  authorized: boolean;
};

type InternalRouteMiddlewareContext = {
  [userGuardAuthorizationState]?: UserGuardAuthorizationState;
};

export type RouteMiddlewareContext = {
  request: Request;
  url: URL;
  env: RouteEnvironment;
  readonly [userGuardAuthorizationState]: UserGuardAuthorizationState;
};

export type RouteMiddleware = (
  context: RouteMiddlewareContext,
) => RouteMiddlewareResult | Promise<RouteMiddlewareResult>;
```

Delete the old declarations at `src/router.ts:614-623`.

- [ ] **Step 2: Reuse the branded type for internal middleware execution**

Replace the inline middleware callback context in `RouteExecutionOptions` with:

```ts
middleware?: readonly ((
  context: RouteMiddlewareContext & { bindings?: unknown },
) => RouteMiddlewareResult | Promise<RouteMiddlewareResult>)[];
```

Annotate the router-created context:

```ts
const middlewareContext: RouteMiddlewareContext & { bindings?: unknown } = {
  request: middlewareRequest,
  url: new URL(url),
  env,
  bindings,
  [userGuardAuthorizationState]: authorizationState,
};
```

- [ ] **Step 3: Derive Workers middleware from the common context**

Import `RouteMiddlewareContext` as a type in `src/adapters/workers.ts` and define:

```ts
export type WorkersRouteMiddleware<Env> = (
  context: RouteMiddlewareContext & { bindings: Env },
) => ReturnType<NonNullable<RouteRenderOptions["middleware"]>[number]>;
```

- [ ] **Step 4: Run the source and package type contracts**

Run:

```bash
pnpm build
pnpm verify:package
```

Expected: both commands pass. The emitted `dist/router.d.ts` contains a non-exported `unique symbol` declaration referenced by the exported `RouteMiddlewareContext`, spread wrappers compile, and both manual reconstructions consume their `@ts-expect-error` directives.

- [ ] **Step 5: Commit the type boundary**

Run:

```bash
git add src/router.ts src/adapters/workers.ts tests/middleware-context-types.ts scripts/verify-middleware-context-types.mjs package.json
git commit -m "fix: brand router middleware contexts"
```

### Task 3: Reject missing authorization carriers at runtime

**Files:**

- Modify: `tests/router-security.test.ts:792-921`
- Modify: `src/router.ts:625-648`
- Modify: `src/router.ts:1302-1342`

- [ ] **Step 1: Add a runtime regression test**

Add this test beside the existing wrapped `requireUser()` tests:

```ts
it("rejects reconstructed guard contexts before identity lookup", async () => {
  const { requireUser } = await import("../src/router");
  let getUserCalled = false;
  let actionCalled = false;
  const guard = requireUser(() => {
    getUserCalled = true;
    return { id: "user" };
  });

  await expect(
    renderRoute(
      [
        {
          path: "/admin",
          action: () => {
            actionCalled = true;
          },
          render: () => "ok",
        },
      ],
      new Request("https://x.test/admin", { method: "POST" }),
      {
        middleware: [
          (context) => {
            const { request, url, env } = context;
            return guard({
              request: request.clone(),
              url: new URL(url),
              env,
            } as Parameters<typeof guard>[0]);
          },
        ],
      },
    ),
  ).rejects.toThrow("requireUser must receive the complete router-supplied middleware context");
  expect(getUserCalled).toBe(false);
  expect(actionCalled).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and observe the intended red state**

Run:

```bash
pnpm vitest run tests/router-security.test.ts -t "rejects reconstructed guard contexts before identity lookup"
```

Expected: FAIL because the current `requireUser()` calls `getUser()` and accepts a context without the carrier.

- [ ] **Step 3: Validate the carrier before identity lookup**

At the start of the returned middleware in `requireUser()`, read the runtime boundary through the optional internal view and reject a missing state:

```ts
const middleware: RouteMiddleware = async (context) => {
  const authorizationState = (context as InternalRouteMiddlewareContext)[userGuardAuthorizationState];
  if (!authorizationState) {
    throw new TypeError("requireUser must receive the complete router-supplied middleware context.");
  }
  const { request, url } = context;
  const user = await getUser({ request, url });
  if (user) {
    await options.onUser?.({ request, url, user });
    authorizationState.authorized = true;
    return;
  }
  if (options.forbidden) {
    return options.forbidden({ request, url });
  }
  return redirect(options.getRedirect?.({ request, url }) ?? options.redirectTo ?? "/login");
};
```

Remove `userGuardAuthorizedRequests`, its `.add()` call, and the WeakSet fallback from `authorizedByMiddleware`. The per-invocation opaque carrier becomes the single authorization channel:

```ts
const authorizedByMiddleware = authorizationState.authorized;
```

- [ ] **Step 4: Run focused security regressions**

Run:

```bash
pnpm vitest run tests/router-security.test.ts -t "requireUser|authorization|guard context"
```

Expected: all selected tests pass, including direct middleware, spread wrappers, cloned wrappers, denial responses, request replacement, and concurrent state isolation.

- [ ] **Step 5: Commit runtime fail-closed behavior**

Run:

```bash
git add src/router.ts tests/router-security.test.ts
git commit -m "fix: reject reconstructed authorization contexts"
```

### Task 4: Document the enforced wrapper contract

**Files:**

- Modify: `docs/routing.md:62-65`

- [ ] **Step 1: Replace the advisory-only wording**

Replace the existing wrapped guard paragraph with:

```markdown
Middleware wrappers that replace the request passed to `requireUser()` must derive the next context from the complete router-supplied context, for example `{ ...context, request: context.request.clone() }`. Object spread carries the opaque, router-owned authorization state while isolating request reads. TypeScript rejects reconstruction from named public fields, and JavaScript or cast-based callers that omit the carrier receive a `TypeError` before identity lookup.
```

- [ ] **Step 2: Check documentation formatting**

Run:

```bash
git diff --check
pnpm lint
```

Expected: `git diff --check` exits successfully. `pnpm lint` exits successfully with only the repository's four existing `no-control-regex` warnings.

- [ ] **Step 3: Commit documentation**

Run:

```bash
git add docs/routing.md
git commit -m "docs: explain opaque guard contexts"
```

### Task 5: Run deterministic verification

**Files:**

- Verify only; no source edits unless a command exposes a regression.

- [ ] **Step 1: Run focused type and runtime verification**

Run:

```bash
pnpm build
pnpm verify:package
pnpm vitest run tests/router-security.test.ts
```

Expected: all commands pass.

- [ ] **Step 2: Run the complete repository gates**

Run:

```bash
pnpm lint
pnpm build
pnpm build:create-package
pnpm test
pnpm verify:package
pnpm verify:starters
pnpm check:exports
pnpm check:size
pnpm check:browser-entry
pnpm check:quick-example-size
pnpm verify:whitespace-types
```

Expected: every command exits successfully. Record the Vitest file/test totals and bundle-size outputs in the work log.

- [ ] **Step 3: Verify the exact diff**

Run:

```bash
git diff --check e9b193d..HEAD
git status --short --branch
```

Expected: no whitespace errors and no tracked changes. Local ignored planning and work-log artifacts may remain.

### Task 6: Complete independent security and correctness reviews

**Files:**

- Review: `src/router.ts`
- Review: `src/adapters/workers.ts`
- Review: `tests/middleware-context-types.ts`
- Review: `tests/router-security.test.ts`
- Review: `scripts/verify-middleware-context-types.mjs`
- Review: `package.json`
- Review: `docs/routing.md`

- [ ] **Step 1: Request Security Specialist review**

Give a clean-context reviewer only the original finding, acceptance criteria, final diff, relevant files, and verification results. Require this output:

```text
Must Fix
- None, or evidence-backed blocking findings.

Should Fix
- Non-blocking hardening findings with file and line evidence.

Notes
- Trust assumptions, residual risk, and verification observations.
```

Expected: no Must Fix findings before integration.

- [ ] **Step 2: Request clean-context correctness review**

Ask a separate reviewer to verify:

- non-exported `unique symbol` declaration behavior;
- platform-neutral and Workers source compatibility;
- runtime rejection ordering;
- removal of the WeakSet fallback;
- test mutation sensitivity;
- package verifier cleanup and workspace-escape protection.

Expected: APPROVED with no blocking correctness findings.

- [ ] **Step 3: Address any blocking finding with TDD**

If either reviewer reports a blocking finding, add a reproducing test, observe failure, apply the smallest fix, rerun focused and full verification, commit the correction, and repeat both reviews. Do not merge while a Security Specialist Must Fix or correctness blocker remains.

### Task 7: Record the work and report integration state

**Files:**

- Create: `docs.local/logs/2026-07-25/2026-07-25-008-opaque-middleware-context-fix.md`

- [ ] **Step 1: Write the Japanese work log**

Record:

- the reproduced failure and root cause;
- selected and rejected designs;
- coverage obligation status;
- commit hashes;
- focused and full verification results;
- Security Specialist Must Fix / Should Fix / Notes;
- correctness review result;
- `git status`, local `main` versus `origin/main`, and whether anything was pushed or merged;
- process lifecycle check.

- [ ] **Step 2: Check for task-started process leaks**

No development server or browser is required by this plan. Verify that no task-started process remains. Do not terminate unrelated existing processes.

- [ ] **Step 3: Report the exact outcome**

State whether the fix exists only on local `main`, whether `origin/main` is still behind, the final commits, all verification totals, review status, and the work-log path. Do not claim a push or remote merge unless it was explicitly performed and verified.
