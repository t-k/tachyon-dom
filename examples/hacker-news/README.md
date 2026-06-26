# Tachyon News

Read-only Hacker News clone for exercising Tachyon DOM SSR, streaming, and Cloudflare Workers Static Assets.

## Scope

- Renders Hacker News top stories from the official Firebase API.
- Streams the HTML shell first, then the story list.
- Serves static assets through the Cloudflare `ASSETS` binding.
- Does not implement login, voting, posting, comments, or search.

## Local Verification

```sh
pnpm example:hacker-news:build
pnpm vitest run tests/example-hacker-news.test.ts
```

## Deploy

```sh
pnpm example:hacker-news:deploy
```

Wrangler must be authenticated with a Cloudflare account before deployment.
