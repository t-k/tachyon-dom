import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatRelativeTime,
  hostForStory,
  loadTopStories,
  storyFromItem,
  type HackerNewsStory,
} from "../examples/hacker-news/hn-api";
import {
  renderHackerNewsDocument,
  renderHackerNewsError,
  renderHackerNewsStream,
} from "../examples/hacker-news/renderer";
import { createHackerNewsWorker } from "../examples/hacker-news/worker";

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

  it("declares Cloudflare deployment config and package scripts", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const wrangler = readFileSync(join(process.cwd(), "examples", "hacker-news", "wrangler.jsonc"), "utf8");

    expect(packageJson.scripts["example:hacker-news:deploy"]).toBe(
      "wrangler deploy --config examples/hacker-news/wrangler.jsonc",
    );
    expect(wrangler).toContain('"main": "./worker.ts"');
    expect(wrangler).toContain('"binding": "ASSETS"');
    expect(wrangler).toContain('"directory": "./public"');
    expect(wrangler).toContain('"run_worker_first": true');
  });
});

const story = (id: number, title = `Story ${id}`): HackerNewsStory => ({
  age: "1 hour ago",
  comments: id,
  domain: "example.com",
  hnUrl: `https://news.ycombinator.com/item?id=${id}`,
  href: `https://example.com/${id}`,
  id,
  score: id * 10,
  title,
  user: "alice",
});

describe("Hacker News example renderer", () => {
  it("renderer emits a complete SSR document with escaped story data", () => {
    const html = renderHackerNewsDocument({
      stories: [story(1, `Fast <script>alert("x")</script> SSR`)],
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Tachyon News");
    expect(html).toContain(`<link rel="stylesheet" href="/assets/styles.css" />`);
    expect(html).toContain("Fast &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; SSR");
    expect(html).not.toContain("<script>alert");
  });

  it("renderer defers only below-fold story rows with content-visibility", () => {
    const html = renderHackerNewsDocument({
      stories: Array.from({ length: 12 }, (_, index) => story(index + 1)),
    });

    expect(html).toContain(`data-rank="1"`);
    expect(html).toContain(`data-rank="11" class="story-row story-row-deferred"`);
    const css = readFileSync(join(process.cwd(), "examples", "hacker-news", "public", "assets", "styles.css"), "utf8");
    expect(css).toContain("content-visibility: auto");
    expect(css).toContain("contain-intrinsic-size");
  });

  it("renderer emits a readable error panel", () => {
    const html = renderHackerNewsError("Unable to load top stories");

    expect(html).toContain("Unable to load top stories");
    expect(html).toContain('data-state="error"');
  });

  it("streaming yields shell before story rows", async () => {
    const chunks: string[] = [];
    for await (const chunk of renderHackerNewsStream({
      loadStories: async () => ({ ok: true, value: [story(1, "Streaming SSR")] }),
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain("Top stories");
    expect(chunks.join("")).toContain("Streaming SSR");
    expect(chunks.join("")).not.toContain("Loading top stories");
  });
});

describe("Hacker News example Worker", () => {
  it("Worker streams the Hacker News HTML route", async () => {
    const worker = createHackerNewsWorker({
      loadStories: async () => ({ ok: true, value: [story(1, "Worker SSR")] }),
    });

    const response = await worker.fetch(new Request("https://example.com/"), {});

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("'report-sample'");
    expect(await response.text()).toContain("Worker SSR");
  });

  it("Worker sends asset requests to the Cloudflare Assets binding", async () => {
    const worker = createHackerNewsWorker({
      loadStories: async () => ({ ok: true, value: [story(1)] }),
    });
    let seenUrl = "";
    const response = await worker.fetch(new Request("https://example.com/assets/styles.css"), {
      ASSETS: {
        fetch: async (request: Request) => {
          seenUrl = request.url;
          return new Response("body { color: black; }", {
            headers: { "content-type": "text/css; charset=utf-8" },
          });
        },
      },
    });

    expect(seenUrl).toBe("https://example.com/assets/styles.css");
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("'report-sample'");
    expect(await response.text()).toContain("color");
  });

  it("Worker rejects non-read methods on the HTML route", async () => {
    const worker = createHackerNewsWorker({
      loadStories: async () => ({ ok: true, value: [story(1)] }),
    });

    const response = await worker.fetch(new Request("https://example.com/", { method: "POST" }), {});

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("Worker renders error HTML when the Hacker News API fails", async () => {
    const worker = createHackerNewsWorker({
      loadStories: async () => ({ ok: false, error: { message: "upstream unavailable" } }),
    });

    const response = await worker.fetch(new Request("https://example.com/"), {});

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("upstream unavailable");
  });
});
