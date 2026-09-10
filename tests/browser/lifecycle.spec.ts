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
    runConditionalFollowup: () => {
      mount: {
        text: string;
        rightPreserved: boolean;
        leftClicks: number;
        rightClicks: number;
        disposedRightListener: boolean;
        formRemoved: boolean;
        formRecreated: boolean;
      };
      hydrate: {
        materialized: boolean;
        multipleTextBindings: boolean;
        serverIdentity: boolean;
        recreated: boolean;
        genericFormPreserved: boolean;
        genericFormRemoved: boolean;
        genericFormRecreated: boolean;
        genericFooterUpdated: boolean;
        text: string;
      };
      sharedParent: {
        before: { ok: boolean; identityPreserved: boolean; updated: boolean; message: string };
        after: { ok: boolean; identityPreserved: boolean; updated: boolean; message: string };
      };
      conditionalShapes: Array<{ ok: boolean; staticPreserved: boolean; tailUpdated: boolean }>;
      componentSplit: { ok: boolean; identityPreserved: boolean; updated: boolean; message: string };
      listFooter: { mountCorrect: boolean; hydrateCorrect: boolean };
      dynamicShapes: Array<{
        ok: boolean;
        staticPreserved: boolean;
        tailUpdated: boolean;
        branchToggled: boolean;
        message: string;
      }>;
      dynamicAttributes: { ok: boolean; identity: boolean; titleUpdated: boolean; classToggled: boolean };
      listHeader: { mountCorrect: boolean; hydrateCorrect: boolean };
      listTextOnly: { mountCorrect: boolean; hydrateCorrect: boolean };
      listSeparateParent: { mountCorrect: boolean; hydrateCorrect: boolean };
      largeBranch: {
        ok: boolean;
        message: string;
        rows: number;
        adoptedServerList: boolean;
        adoptedRows: number;
        lastUpdated: boolean;
        hiddenRows: number;
        footerStable: boolean;
        footerUpdated: boolean;
        shownRows: number;
        recreatedList: boolean;
        secondLastUpdated: boolean;
        footerAfterShow: boolean;
        finalRows: number;
        hydrateMs: number;
        hideMs: number;
        showMs: number;
      };
    };
    __conditionalReady?: boolean;
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
    staticClosure: string[];
    boundaryClosure: string[];
  };
  // The fixture only uses the event runtime inside its boundary, so the
  // hydrate-only entry's static module graph must not contain it.
  expect(manifest.staticClosure.some((id) => id.endsWith("/runtime/event.js"))).toBe(false);
  expect(manifest.boundaryClosure.some((id) => id.endsWith("/runtime/event.js"))).toBe(true);
  expect(manifest.staticClosure.some((id) => id.endsWith("/runtime/hydrate.js"))).toBe(true);
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

test("runs generated adjacent conditional mount and SSR hydration regressions in a real browser", async ({
  page,
  browserName,
}) => {
  await page.goto("/tests/browser/generated/conditional-fixture.html");
  await page.waitForFunction(() => window.__conditionalReady === true);
  const result = await page.evaluate(() => window.runConditionalFollowup());

  expect(result.mount.text).toBe("A2B2Static3");
  expect(result.mount.rightPreserved).toBe(true);
  expect(result.mount.leftClicks).toBe(0);
  expect(result.mount.rightClicks).toBe(1);
  expect(result.mount.disposedRightListener).toBe(true);
  expect(result.mount.formRemoved).toBe(true);
  expect(result.mount.formRecreated).toBe(true);
  expect(result.hydrate.materialized).toBe(true);
  expect(result.hydrate.multipleTextBindings).toBe(true);
  expect(result.hydrate.serverIdentity).toBe(false);
  expect(result.hydrate.recreated).toBe(true);
  expect(result.hydrate.genericFormPreserved).toBe(true);
  expect(result.hydrate.genericFormRemoved).toBe(true);
  expect(result.hydrate.genericFormRecreated).toBe(true);
  expect(result.hydrate.genericFooterUpdated).toBe(true);
  expect(result.hydrate.text).toBe("secondHydrated footer 2");
  expect(result.sharedParent.before).toEqual({ ok: true, identityPreserved: true, updated: true, message: "" });
  expect(result.sharedParent.after).toEqual({ ok: true, identityPreserved: true, updated: true, message: "" });
  expect(result.conditionalShapes).toEqual([
    { ok: true, staticPreserved: true, tailUpdated: true },
    { ok: true, staticPreserved: true, tailUpdated: true },
  ]);
  expect(result.dynamicShapes).toEqual(
    Array.from({ length: 5 }, () => ({
      ok: true,
      staticPreserved: true,
      tailUpdated: true,
      branchToggled: true,
      message: "",
    })),
  );
  expect(result.dynamicAttributes).toEqual({ ok: true, identity: true, titleUpdated: true, classToggled: true });
  expect(result.componentSplit).toEqual({ ok: true, identityPreserved: true, updated: true, message: "" });
  expect(result.listFooter).toEqual({ mountCorrect: true, hydrateCorrect: true });
  expect(result.listHeader).toEqual({ mountCorrect: true, hydrateCorrect: true });
  expect(result.listTextOnly).toEqual({ mountCorrect: true, hydrateCorrect: true });
  expect(result.listSeparateParent).toEqual({ mountCorrect: true, hydrateCorrect: true });
  const { largeBranch } = result;
  expect(largeBranch.message).toBe("");
  expect(largeBranch.ok).toBe(true);
  expect(largeBranch.adoptedServerList).toBe(true);
  expect(largeBranch.adoptedRows).toBe(largeBranch.rows);
  expect(largeBranch.lastUpdated).toBe(true);
  expect(largeBranch.hiddenRows).toBe(0);
  expect(largeBranch.footerStable).toBe(true);
  expect(largeBranch.footerUpdated).toBe(true);
  expect(largeBranch.shownRows).toBe(largeBranch.rows);
  expect(largeBranch.recreatedList).toBe(true);
  expect(largeBranch.secondLastUpdated).toBe(true);
  expect(largeBranch.footerAfterShow).toBe(true);
  expect(largeBranch.finalRows).toBe(0);
  console.log(
    `[${browserName}] large conditional branch: ${largeBranch.rows} rows, hydrate ${largeBranch.hydrateMs.toFixed(3)}ms, hide ${largeBranch.hideMs.toFixed(3)}ms, show ${largeBranch.showMs.toFixed(3)}ms`,
  );
  expect(["chromium", "firefox", "webkit"]).toContain(browserName);
});
