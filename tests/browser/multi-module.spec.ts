import { expect, test } from "@playwright/test";

// This is only the fixture control surface. All template bindings come from real Vite-built .td modules.
declare global {
  interface Window {
    multiModule: {
      propsStarts(): number;
      propsAdopted(): boolean;
      updateProps(label: string): void;
      disposeProps(): void;
      updateGetter(label: string): void;
      oldPropsText(): string;
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

test("updates component props before and after deferred hydration while retaining local state", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture);
  await expect.poll(() => page.evaluate(() => window.multiModule?.propsStarts())).toBe(2);
  expect(await page.evaluate(() => window.multiModule.propsAdopted())).toBe(true);
  await page.evaluate(() => window.multiModule.updateProps("after"));
  await expect(page.locator("#props [data-eager]")).toHaveText("after!");
  await expect(page.locator("#props [data-label]")).toHaveText("before!");
  await page.locator("#props [data-label]").click();
  await expect(page.locator("#props [data-label]")).toHaveText("after!");
  await page.locator("#props input").fill("7");
  await expect(page.locator("#props output")).toHaveText("7");
  await page.evaluate(() => window.multiModule.updateProps("updated"));
  await expect(page.locator("#props [data-label]")).toHaveText("updated!");
  await expect(page.locator("#props output")).toHaveText("7");
  await expect(page.locator("#props-other [data-label]")).toHaveText("other!");
  await expect(page.locator("#props-other output")).toHaveText("0");
  expect(await page.evaluate(() => window.multiModule.propsStarts())).toBe(2);
  expect(await page.evaluate(() => window.multiModule.propsAdopted())).toBe(true);
  await page.evaluate(() => {
    window.multiModule.disposeProps();
    window.multiModule.updateProps("disposed");
  });
  expect(await page.evaluate(() => window.multiModule.oldPropsText())).toBe("updated!");
  await page.evaluate(() => window.multiModule.dispose());
  expect(errors).toEqual([]);
});

test("binds default scope getters that return fresh values without re-evaluation loops", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture);
  await expect.poll(() => page.evaluate(() => typeof window.multiModule?.updateGetter)).toBe("function");
  await expect(page.locator("#getter [data-count]")).toHaveText("2");
  await expect(page.locator("#getter [data-first]")).toHaveText("A");
  await expect(page.locator("#getter [data-count-again]")).toHaveText("2");
  await page.evaluate(() => window.multiModule.updateGetter("B"));
  await expect(page.locator("#getter [data-first]")).toHaveText("B");
  await expect(page.locator("#getter [data-count]")).toHaveText("2");
  await page.evaluate(() => window.multiModule.dispose());
  expect(errors).toEqual([]);
});

test("repeats local edits after props change in a getter SFC with a store", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture);
  const input = page.locator("#getter input");
  const output = page.locator("#getter output");
  await expect(output).toHaveText("A");
  await input.fill("B");
  await expect(output).toHaveText("B");
  await page.evaluate(() => window.multiModule.updateGetter("C"));
  await expect(input).toHaveValue("C");
  await expect(output).toHaveText("C");
  await input.fill("B");
  await expect(input).toHaveValue("B");
  await expect(output).toHaveText("B");
  await expect(page.locator("#getter [data-first]")).toHaveText("B");
  await page.evaluate(() => window.multiModule.dispose());
  expect(errors).toEqual([]);
});
