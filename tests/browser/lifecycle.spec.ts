import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    runLifecycle: () => {
      engine: string;
      sameRow: boolean;
      focused: boolean;
      value: string;
      remainingRows: number;
      hydrationChanged: boolean;
      hydrated: boolean;
    };
    runLazyHydration: () => Promise<{
      before: string;
      during: string;
      unchangedBeforeHydration: boolean;
      opened: boolean;
      hydrated: boolean;
    }>;
    __lazyReady?: boolean;
    __lazySetupRuns?: number;
    __lazySubmits?: number;
    __lazyStop?: () => void;
  }
}

test("preserves moved row state, focus, form value, and hydration DOM in every engine", async ({
  page,
  browserName,
}) => {
  await page.goto("/tests/browser/lifecycle-fixture.html");
  const result = await page.evaluate(() => window.runLifecycle());

  expect(result.engine).toBeTruthy();
  expect(result.sameRow).toBe(true);
  expect(result.focused).toBe(true);
  expect(result.value).toBe("edited");
  expect(result.remainingRows).toBe(1);
  expect(result.hydrationChanged).toBe(true);
  expect(result.hydrated).toBe(true);
  expect(["chromium", "firefox", "webkit"]).toContain(browserName);
});

test("defers a boundary chunk and replays the first interaction in every engine", async ({ page, browserName }) => {
  await page.goto("/tests/browser/lifecycle-fixture.html");
  const result = await page.evaluate(() => window.runLazyHydration());

  expect(result.unchangedBeforeHydration).toBe(true);
  expect(result.before).toBe(result.during);
  expect(result.opened).toBe(true);
  expect(result.hydrated).toBe(false);
  expect(["chromium", "firefox", "webkit"]).toContain(browserName);
});

test("loads the Vite-built boundary chunk only after the first interaction and runs setup once", async ({
  page,
  browserName,
}) => {
  const manifest = JSON.parse(await readFile(new URL("./generated/manifest.json", import.meta.url), "utf8")) as {
    boundaryChunk: string;
    ssrMarkup: string;
  };
  const chunkRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/generated/${manifest.boundaryChunk}`)) chunkRequests.push(request.url());
  });

  await page.goto("/tests/browser/generated/lazy-sfc-fixture.html");
  await page.waitForFunction(() => window.__lazyReady === true);
  const beforeInteraction = await page.evaluate(() => ({
    setupRuns: window.__lazySetupRuns ?? 0,
    submits: window.__lazySubmits ?? 0,
    html: document.querySelector("#generated-lazy")?.outerHTML ?? "",
  }));
  expect(chunkRequests).toEqual([]);
  expect(beforeInteraction.setupRuns).toBe(1);
  expect(beforeInteraction.submits).toBe(0);
  expect(beforeInteraction.html).toBe(manifest.ssrMarkup);

  await page.click("#generated-lazy button");
  await page.waitForFunction(() => (window.__lazySubmits ?? 0) >= 1);
  await page.waitForTimeout(100);
  const afterInteraction = await page.evaluate(() => ({
    setupRuns: window.__lazySetupRuns ?? 0,
    submits: window.__lazySubmits ?? 0,
    html: document.querySelector("#generated-lazy")?.outerHTML ?? "",
    url: location.href,
  }));

  expect(chunkRequests).toHaveLength(1);
  expect(afterInteraction.setupRuns).toBe(1);
  expect(afterInteraction.submits).toBe(1);
  expect(afterInteraction.html).toBe(manifest.ssrMarkup);
  expect(afterInteraction.url).not.toContain("?");
  expect(["chromium", "firefox", "webkit"]).toContain(browserName);
});
