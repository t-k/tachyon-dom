import { expect, test } from "@playwright/test";

// This is only the fixture control surface. All template bindings come from real Vite-built .td modules.
declare global {
  interface Window {
    multiModule: {
      events: { a: number; b: number; lazy: number; ssr: number };
      ssrAdopted: boolean;
      setShared(value: number): void;
      loadLazy(): Promise<void>;
      disposeA1(): void;
      fireOldA1(): string;
      remountA1(): void;
      disposeSsr(): void;
      fireOldSsr(): string;
      remountSsr(): void;
      dispose(): void;
    };
  }
}

const fixture = "/tests/browser/generated/multi-module/";

test("isolates real module instances while sharing signals across a production lazy chunk", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const manifest = await (await page.request.get(`${fixture}manifest.json`)).json();
  await page.goto(fixture);
  await expect(page.locator("#a1 [data-count]")).toHaveText("0");
  await expect(page.locator("#a2 [data-count]")).toHaveText("0");
  await expect(page.locator("#b [data-count]")).toHaveText("10");
  await expect(page.locator("#a1 li")).toHaveText("A0");
  await expect(page.locator("#a2 li")).toHaveText("A0");
  await expect(page.locator("#b li")).toHaveText("B10");
  // An externally supplied method still reads the setup binding the template never referenced.
  await expect(page.locator("#scoped [data-label]")).toHaveText("READY");
  for (const id of ["a1", "a2", "b"]) await expect(page.locator(`#${id} [data-shared]`)).toHaveText("0");
  expect(await page.evaluate(() => window.multiModule.events)).toEqual({ a: 0, b: 0, lazy: 0, ssr: 0 });
  expect(requests.some((url) => url.endsWith(manifest.lazyChunk))).toBe(false);

  await page.locator("#a1 [data-count]").click();
  await expect(page.locator("#a1 [data-count]")).toHaveText("1");
  await expect(page.locator("#a1 li")).toHaveText("A1");
  await expect(page.locator("#a2 [data-count]")).toHaveText("0");
  await expect(page.locator("#a2 li")).toHaveText("A0");
  await expect(page.locator("#b [data-count]")).toHaveText("10");
  await expect(page.locator("#b li")).toHaveText("B10");
  expect(await page.evaluate(() => window.multiModule.events.a)).toBe(1);

  await page.evaluate(() => window.multiModule.setShared(7));
  for (const id of ["a1", "a2", "b"]) await expect(page.locator(`#${id} [data-shared]`)).toHaveText("7");
  await page.evaluate(() => window.multiModule.loadLazy());
  expect(requests.some((url) => url.endsWith(manifest.lazyChunk))).toBe(true);
  await expect(page.locator("#lazy [data-shared]")).toHaveText("7");
  await expect(page.locator("#lazy [data-count]")).toHaveText("20");
  await page.locator("#lazy [data-count]").click();
  await expect(page.locator("#lazy [data-count]")).toHaveText("21");
  await expect(page.locator("#lazy li")).toHaveText("L21");
  await expect(page.locator("#a1 [data-count]")).toHaveText("1");

  await page.evaluate(() => window.multiModule.disposeA1());
  await page.evaluate(() => window.multiModule.setShared(9));
  expect(await page.evaluate(() => window.multiModule.fireOldA1())).toBe("7");
  expect(await page.evaluate(() => window.multiModule.events.a)).toBe(1);
  for (const id of ["a2", "b", "lazy"]) await expect(page.locator(`#${id} [data-shared]`)).toHaveText("9");
  await page.locator("#a2 [data-count]").click();
  await page.locator("#b [data-count]").click();
  await expect(page.locator("#a2 [data-count]")).toHaveText("1");
  await expect(page.locator("#b [data-count]")).toHaveText("11");
  await expect(page.locator("#a2 li")).toHaveText("A1");
  await expect(page.locator("#b li")).toHaveText("B11");

  await page.evaluate(() => window.multiModule.remountA1());
  await expect(page.locator("#a1 [data-count]")).toHaveText("0");
  await expect(page.locator("#a1 [data-shared]")).toHaveText("9");
  await page.locator("#a1 [data-count]").click();
  await expect(page.locator("#a1 [data-count]")).toHaveText("1");
  await expect(page.locator("#a2 [data-count]")).toHaveText("1");
  expect(await page.evaluate(() => window.multiModule.events)).toEqual({ a: 3, b: 1, lazy: 1, ssr: 0 });
  await page.evaluate(() => window.multiModule.dispose());
  expect(errors).toEqual([]);
});

test("updates empty SSR text after deferred hydration and releases subscriptions on remount", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture);
  await expect(page.locator("#ssr [data-eager]")).toHaveText("0");
  await expect.poll(() => page.evaluate(() => window.multiModule?.ssrAdopted)).toBe(true);
  await expect(page.locator("#ssr [data-text]")).toHaveText("");
  expect(await page.locator("#ssr [data-text]").evaluate((node) => node.firstChild?.nodeType)).toBe(8);
  await page.evaluate(() => window.multiModule.setShared(7));
  await expect(page.locator("#ssr [data-eager]")).toHaveText("7");
  await expect(page.locator("#ssr [data-text]")).toHaveText("");
  await page.locator("#ssr [data-count]").click();
  await expect(page.locator("#ssr [data-count]")).toHaveText("1");
  await expect(page.locator("#ssr [data-text]")).toHaveText("shared:7");
  expect(await page.evaluate(() => window.multiModule.events.ssr)).toBe(1);
  await page.evaluate(() => window.multiModule.setShared(9));
  await expect(page.locator("#ssr [data-text]")).toHaveText("shared:9");
  await page.evaluate(() => window.multiModule.disposeSsr());
  await page.evaluate(() => window.multiModule.setShared(11));
  expect(await page.evaluate(() => window.multiModule.fireOldSsr())).toBe("shared:9");
  expect(await page.evaluate(() => window.multiModule.events.ssr)).toBe(1);
  await page.evaluate(() => window.multiModule.remountSsr());
  await expect(page.locator("#ssr [data-text]")).toHaveText("shared:11");
  await expect(page.locator("#ssr [data-count]")).toHaveText("0");
  await page.locator("#ssr [data-count]").click();
  await expect(page.locator("#ssr [data-count]")).toHaveText("1");
  expect(await page.evaluate(() => window.multiModule.events.ssr)).toBe(2);
  await page.evaluate(() => window.multiModule.setShared(13));
  await expect(page.locator("#ssr [data-text]")).toHaveText("shared:13");
  await page.evaluate(() => window.multiModule.dispose());
  expect(errors).toEqual([]);
});
