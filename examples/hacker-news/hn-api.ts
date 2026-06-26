import { err, ok, type Result } from "../../src/result";

const hnApiBase = "https://hacker-news.firebaseio.com/v0";
const hnItemBase = "https://news.ycombinator.com/item";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HackerNewsItem = {
  id?: unknown;
  type?: unknown;
  by?: unknown;
  time?: unknown;
  title?: unknown;
  url?: unknown;
  score?: unknown;
  descendants?: unknown;
};

export type HackerNewsStory = {
  id: number;
  title: string;
  href: string;
  domain: string;
  user: string;
  score: number;
  comments: number;
  age: string;
  hnUrl: string;
};

export type HackerNewsLoadOptions = {
  fetch?: FetchLike;
  limit?: number;
  now?: number;
  signal?: AbortSignal;
};

export type HackerNewsError = {
  message: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object");

const numberValue = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const stringValue = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

const hnItemUrl = (id: number): string => `${hnItemBase}?id=${id}`;

const safeStoryUrl = (id: number, value: unknown): string => {
  if (typeof value !== "string") {
    return hnItemUrl(id);
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : hnItemUrl(id);
  } catch {
    return hnItemUrl(id);
  }
};

export const hostForStory = (story: Pick<HackerNewsStory, "href"> | undefined): string => {
  if (!story) {
    return "";
  }
  try {
    const host = new URL(story.href).hostname;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "news.ycombinator.com";
  }
};

export const formatRelativeTime = (timeSeconds: number, now = Date.now()): string => {
  const elapsedSeconds = Math.max(0, Math.floor(now / 1000) - timeSeconds);
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) {
    return `${Math.max(1, minutes)} ${Math.max(1, minutes) === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
};

export const storyFromItem = (item: HackerNewsItem | unknown, now = Date.now()): HackerNewsStory | undefined => {
  if (!isRecord(item)) {
    return undefined;
  }
  const id = numberValue(item.id, Number.NaN);
  const title = stringValue(item.title).trim();
  if (!Number.isFinite(id) || !title || item.type !== "story") {
    return undefined;
  }
  const href = safeStoryUrl(id, item.url);
  const story = {
    age: formatRelativeTime(numberValue(item.time), now),
    comments: numberValue(item.descendants),
    domain: "",
    hnUrl: hnItemUrl(id),
    href,
    id,
    score: numberValue(item.score),
    title,
    user: stringValue(item.by, "unknown"),
  };
  return { ...story, domain: hostForStory(story) };
};

const readJson = async (response: Response, label: string): Promise<Result<unknown, HackerNewsError>> => {
  if (!response.ok) {
    return err({ message: `Unable to load ${label}: ${response.status}` });
  }
  try {
    return ok(await response.json());
  } catch {
    return err({ message: `Unable to parse ${label}.` });
  }
};

export const fetchTopStoryIds = async (
  fetcher: FetchLike,
  signal?: AbortSignal,
): Promise<Result<number[], HackerNewsError>> => {
  const response = await fetcher(`${hnApiBase}/topstories.json`, { signal });
  const json = await readJson(response, "top stories");
  if (!json.ok) {
    return json;
  }
  if (!Array.isArray(json.value)) {
    return err({ message: "Unable to parse top stories." });
  }
  return ok(json.value.filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
};

export const fetchItem = async (
  fetcher: FetchLike,
  id: number,
  signal?: AbortSignal,
): Promise<Result<HackerNewsItem, HackerNewsError>> => {
  const response = await fetcher(`${hnApiBase}/item/${id}.json`, { signal });
  const json = await readJson(response, `item ${id}`);
  if (!json.ok) {
    return json;
  }
  return isRecord(json.value) ? ok(json.value) : err({ message: `Unable to parse item ${id}.` });
};

export const loadTopStories = async (
  options: HackerNewsLoadOptions = {},
): Promise<Result<HackerNewsStory[], HackerNewsError>> => {
  const fetcher = options.fetch ?? fetch;
  const ids = await fetchTopStoryIds(fetcher, options.signal);
  if (!ids.ok) {
    return ids;
  }
  const now = options.now ?? Date.now();
  const stories = await Promise.all(
    ids.value.slice(0, options.limit ?? 30).map(async (id) => {
      const item = await fetchItem(fetcher, id, options.signal);
      return item.ok ? storyFromItem(item.value, now) : undefined;
    }),
  );
  return ok(stories.filter((story): story is HackerNewsStory => Boolean(story)));
};
