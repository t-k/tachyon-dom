import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatRelativeTime,
  hostForStory,
  loadTopStories,
  storyFromItem,
  type HackerNewsItem,
} from "../examples/hacker-news/hn-api";

const jsonResponse = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

describe("Hacker News example HN API", () => {
  it("HN API loads top stories and converts item JSON to display stories", async () => {
    const responses = new Map<string, Response>([
      ["https://hacker-news.firebaseio.com/v0/topstories.json", jsonResponse([101, 102, 103])],
      [
        "https://hacker-news.firebaseio.com/v0/item/101.json",
        jsonResponse({
          by: "alice",
          descendants: 12,
          id: 101,
          score: 42,
          time: 1_700_000_000,
          title: "A useful system",
          type: "story",
          url: "https://example.com/posts/system",
        }),
      ],
      [
        "https://hacker-news.firebaseio.com/v0/item/102.json",
        jsonResponse({
          by: "bob",
          descendants: 3,
          id: 102,
          score: 15,
          time: 1_700_000_120,
          title: "Ask HN: Edge SSR?",
          type: "story",
        }),
      ],
      ["https://hacker-news.firebaseio.com/v0/item/103.json", jsonResponse({ id: 103, type: "comment" })],
    ]);
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const response = responses.get(String(input));
      if (!response) {
        throw new Error(`Unexpected URL: ${String(input)}`);
      }
      return response.clone();
    };

    const result = await loadTopStories({ fetch: fetcher, limit: 3, now: 1_700_003_600_000 });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.map((story) => story.id)).toEqual([101, 102]);
    expect(result.ok && result.value[0]?.domain).toBe("example.com");
    expect(result.ok && result.value[1]?.href).toBe("https://news.ycombinator.com/item?id=102");
  });

  it("HN API filters invalid stories and unsafe URLs", () => {
    const missingTitle = storyFromItem({ id: 1, type: "story", url: "https://example.com" }, 1_700_003_600_000);
    const unsafe = storyFromItem(
      {
        by: "mallory",
        id: 2,
        score: 1,
        time: 1_700_000_000,
        title: "Bad URL",
        type: "story",
        url: "javascript:alert(1)",
      },
      1_700_003_600_000,
    );

    expect(missingTitle).toBeUndefined();
    expect(unsafe?.href).toBe("https://news.ycombinator.com/item?id=2");
    expect(hostForStory(unsafe)).toBe("news.ycombinator.com");
  });

  it("HN API returns an error result when the upstream request fails", async () => {
    const result = await loadTopStories({
      fetch: async () => new Response("unavailable", { status: 503 }),
      limit: 3,
      now: 1_700_003_600_000,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("top stories");
  });

  it("HN API formats relative story ages", () => {
    expect(formatRelativeTime(1_700_000_000, 1_700_003_600_000)).toBe("1 hour ago");
    expect(formatRelativeTime(1_699_917_200, 1_700_003_600_000)).toBe("1 day ago");
  });
});

describe("Hacker News example files", () => {
  it("keeps the test fixture path anchored in the repository", () => {
    expect(readFileSync(join(process.cwd(), "package.json"), "utf8")).toContain("tachyon-dom");
  });
});
