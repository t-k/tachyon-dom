import { err, type Result } from "../../src/result";
import type { HackerNewsError, HackerNewsStory } from "./hn-api";

export type HackerNewsDocumentOptions = {
  stories: readonly HackerNewsStory[];
  title?: string;
  stylesheet?: string;
};

export type HackerNewsStreamOptions = {
  loadStories: () => Promise<Result<readonly HackerNewsStory[], HackerNewsError>>;
  stylesheet?: string;
};

const defaultTitle = "Tachyon News";
const defaultStylesheet = "/assets/styles.css";

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const storyRowClass = (rank: number): string => (rank > 10 ? "story-row story-row-deferred" : "story-row");

export const renderHackerNewsError = (message: string): string => `
<section class="notice" data-state="error">
  <h2>Unable to load top stories</h2>
  <p>${escapeHtml(message)}</p>
</section>`;

const renderStoryRow = (story: HackerNewsStory, index: number): string => {
  const rank = index + 1;
  return `<article data-rank="${rank}" class="${storyRowClass(rank)}">
  <div class="story-rank">${rank}</div>
  <div class="story-main">
    <h2 class="story-title"><a href="${escapeHtml(story.href)}">${escapeHtml(story.title)}</a></h2>
    <div class="story-meta">
      <span>${escapeHtml(story.domain)}</span>
      <span>${story.score} points</span>
      <span>by ${escapeHtml(story.user)}</span>
      <span>${escapeHtml(story.age)}</span>
      <a href="${escapeHtml(story.hnUrl)}">${story.comments} comments</a>
    </div>
  </div>
</article>`;
};

export const renderHackerNewsList = (stories: readonly HackerNewsStory[]): string => {
  if (stories.length === 0) {
    return `<section class="notice"><h2>No stories available</h2><p>Try refreshing in a moment.</p></section>`;
  }
  return `<section class="story-list" aria-label="Top stories">
${stories.map(renderStoryRow).join("\n")}
</section>`;
};

const renderShellStart = (options: { title?: string; stylesheet?: string } = {}): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.title ?? defaultTitle)}</title>
    <link rel="stylesheet" href="${escapeHtml(options.stylesheet ?? defaultStylesheet)}" />
  </head>
  <body>
    <main class="page-shell">
      <header class="topbar">
        <a class="brand" href="/">Tachyon News</a>
        <nav aria-label="Sections">
          <a href="/">top</a>
          <a href="https://news.ycombinator.com/newest">new</a>
          <a href="https://news.ycombinator.com/ask">ask</a>
          <a href="https://news.ycombinator.com/show">show</a>
        </nav>
      </header>
      <section class="intro">
        <h1>Top stories</h1>
        <p>Read-only Hacker News clone rendered with Tachyon DOM on Cloudflare Workers.</p>
      </section>
      <div id="stories">`;

const renderShellEnd = (): string => `</div>
    </main>
  </body>
</html>
`;

export const renderLoadingState = (): string => `<section class="notice" data-state="loading">
  <h2>Loading top stories</h2>
  <p>The HTML shell has already streamed; stories arrive in the next chunk.</p>
</section>`;

export const renderHackerNewsDocument = (options: HackerNewsDocumentOptions): string =>
  `${renderShellStart(options)}
${renderHackerNewsList(options.stories)}
${renderShellEnd()}`;

export async function* renderHackerNewsStream(options: HackerNewsStreamOptions): AsyncIterable<string> {
  yield `${renderShellStart({ stylesheet: options.stylesheet })}
${renderLoadingState()}`;
  const result = await options.loadStories();
  if (!result.ok) {
    yield renderHackerNewsError(result.error.message);
    yield renderShellEnd();
    return;
  }
  yield renderHackerNewsList(result.value);
  yield renderShellEnd();
}

export const failedHackerNewsStream = (message: string): HackerNewsStreamOptions => ({
  loadStories: async () => err({ message }),
});
