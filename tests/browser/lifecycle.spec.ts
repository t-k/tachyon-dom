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
