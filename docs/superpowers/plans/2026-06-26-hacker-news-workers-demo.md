# Hacker News Workers Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Hacker News clone example that exercises Tachyon DOM SSR, streaming, and Cloudflare Workers Static Assets deployment.

**Architecture:** Create `examples/hacker-news` with a focused HN API client, renderer, Worker entry, CSS, Wrangler config, and README. Use `tachyon-dom/router` streaming for the HTML route and `tachyon-dom/adapters/workers` for Cloudflare runtime integration.

**Tech Stack:** TypeScript, Tachyon DOM router/adapters, Vitest, Wrangler, Cloudflare Workers Static Assets, Hacker News Firebase API.

---

### Task 1: HN API Client

**Files:**
- Create: `examples/hacker-news/hn-api.ts`
- Test: `tests/example-hacker-news.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for parsing top story IDs, converting item JSON to display stories, filtering invalid items, sanitizing external URLs to `http:`/`https:`, and returning a readable failure result.

- [ ] **Step 2: Run red tests**

Run: `pnpm vitest run tests/example-hacker-news.test.ts --testNamePattern "HN API"`

Expected: FAIL because `examples/hacker-news/hn-api.ts` does not exist.

- [ ] **Step 3: Implement minimal client**

Implement `fetchTopStoryIds`, `fetchItem`, `loadTopStories`, `storyFromItem`, `formatRelativeTime`, and `hostForStory`. Use dependency injection for `fetch` and avoid mocks by using deterministic local fetch functions in tests.

- [ ] **Step 4: Run green tests**

Run: `pnpm vitest run tests/example-hacker-news.test.ts --testNamePattern "HN API"`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add examples/hacker-news/hn-api.ts tests/example-hacker-news.test.ts && git commit -m "feat: add hacker news api client example"`

### Task 2: SSR and Streaming Renderer

**Files:**
- Create: `examples/hacker-news/renderer.ts`
- Create: `examples/hacker-news/styles.css`
- Test: `tests/example-hacker-news.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving `renderHackerNewsDocument()` contains shell markup, list markup, escaped titles, stylesheet links, and error panel markup. Add a streaming test proving the first chunk contains shell HTML and a later chunk contains a story row.

- [ ] **Step 2: Run red tests**

Run: `pnpm vitest run tests/example-hacker-news.test.ts --testNamePattern "renderer|streaming"`

Expected: FAIL because renderer functions do not exist.

- [ ] **Step 3: Implement renderer**

Implement HTML escaping, document shell, story list rendering, error rendering, and async streaming chunks. Apply `content-visibility: auto` only to story rows after the first ten items and pair it with `contain-intrinsic-size`.

- [ ] **Step 4: Run green tests**

Run: `pnpm vitest run tests/example-hacker-news.test.ts --testNamePattern "renderer|streaming"`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add examples/hacker-news/renderer.ts examples/hacker-news/styles.css tests/example-hacker-news.test.ts && git commit -m "feat: add hacker news streaming renderer"`

### Task 3: Cloudflare Worker Entry

**Files:**
- Create: `examples/hacker-news/worker.ts`
- Test: `tests/example-hacker-news.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for the Worker route returning streamed HTML on `/`, sending `/assets/app.css` to `env.ASSETS`, and returning error HTML when the HN API dependency fails.

- [ ] **Step 2: Run red tests**

Run: `pnpm vitest run tests/example-hacker-news.test.ts --testNamePattern "Worker"`

Expected: FAIL because `examples/hacker-news/worker.ts` does not exist.

- [ ] **Step 3: Implement Worker**

Implement `createHackerNewsWorker()` around `createWorkersHandler`, `renderRouteStream`, and `createSecurityHeaders`. Keep the default export compatible with Cloudflare Worker module syntax.

- [ ] **Step 4: Run green tests**

Run: `pnpm vitest run tests/example-hacker-news.test.ts --testNamePattern "Worker"`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add examples/hacker-news/worker.ts tests/example-hacker-news.test.ts && git commit -m "feat: add hacker news cloudflare worker"`

### Task 4: Build and Deploy Configuration

**Files:**
- Create: `examples/hacker-news/wrangler.jsonc`
- Create: `examples/hacker-news/README.md`
- Modify: `package.json`
- Test: `tests/example-hacker-news.test.ts`

- [ ] **Step 1: Add scripts**

Add `example:hacker-news:build`, `example:hacker-news:dev`, and `example:hacker-news:deploy` scripts. Use `wrangler deploy --config examples/hacker-news/wrangler.jsonc` for deploy.

- [ ] **Step 2: Add Wrangler config**

Configure Worker name, `main`, `compatibility_date`, `assets.directory`, and `assets.binding`.

- [ ] **Step 3: Add README**

Document local dev, build, deploy, and the read-only scope in English.

- [ ] **Step 4: Run config/build tests**

Run: `pnpm vitest run tests/example-hacker-news.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add examples/hacker-news/wrangler.jsonc examples/hacker-news/README.md package.json tests/example-hacker-news.test.ts && git commit -m "chore: configure hacker news worker deployment"`

### Task 5: Verification, Deployment Attempt, Security Review, Log

**Files:**
- Add: `docs.local/logs/2026-06-26/2026-06-26-006-hacker-news-workers-demo.md`

- [ ] **Step 1: Run verification**

Run: `pnpm vitest run tests/example-hacker-news.test.ts`

Run: `pnpm build`

Run: `pnpm lint`

Expected: all pass.

- [ ] **Step 2: Try Cloudflare deployment**

Run: `pnpm example:hacker-news:deploy`

Expected: deployed URL if Cloudflare credentials are available. If credentials are missing, record the exact Wrangler authentication error and leave the deploy command ready.

- [ ] **Step 3: Security Specialist review**

Review external API data escaping, URL filtering, headers, and route/static asset precedence. Record Must Fix / Should Fix / Notes in the work log. Fix Must Fix issues before final status.

- [ ] **Step 4: Write work log**

Record implementation summary, tests, deployment attempt result, and security review in `docs.local/logs/2026-06-26/2026-06-26-006-hacker-news-workers-demo.md`.

- [ ] **Step 5: Commit any final tracked changes**

Run: `git status --short`

If tracked changes remain, commit them with a focused message.
