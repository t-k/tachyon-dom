// @vitest-environment node

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileTemplate, generateClientModule } from "../src/compiler";
import {
  attributionForMetafile,
  buildClientBundle,
  checkBundleBudget,
  createClientBundleFixtures,
  findForbiddenInputs,
  findUnwantedFeatureInputs,
  runClientBundleAttribution,
  summarizeClientBundle,
  validateFixtureBudgets,
} from "../scripts/client-bundle-attribution.mjs";

const generatedClientEntry = (source: string, options: Record<string, unknown> = {}) => {
  const compiled = compileTemplate(source);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return generateClientModule(compiled.value, { instrumentBindings: false, ...options }).replaceAll(
    'from "tachyon-dom/',
    'from "./dist/',
  );
};

const bytesFor = (result: Awaited<ReturnType<typeof buildClientBundle>>, pattern: RegExp): number =>
  summarizeClientBundle(result)
    .inputs.filter((input) => pattern.test(input.path))
    .reduce((total, input) => total + input.bytesInOutput, 0);

describe("client bundle attribution", () => {
  it("measures distribution imports independently of development TypeScript path aliases", async () => {
    const result = await buildClientBundle(
      `import { createSignal } from "tachyon-dom/runtime/signal"; export const count = createSignal(0);`,
    );
    expect(bytesFor(result, /dist[/\\]runtime[/\\]signal\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(result, /src[/\\]/)).toBe(0);
  });
  // A template whose only attribute is class must not pull in the generic attribute setter, and with it the
  // attribute name policy and URL sanitizer, which never applied to class.
  it("keeps a class-only template free of attribute and URL policy bytes", async () => {
    const classOnly = await buildClientBundle(
      generatedClientEntry(`<div class={theme} class:active={selected}><span class={inner}></span></div>`, {
        reactive: true,
      }),
      { cwd: process.cwd() },
    );
    const withAttribute = await buildClientBundle(
      generatedClientEntry(`<div class={theme} title={label}></div>`, { reactive: true }),
      { cwd: process.cwd() },
    );
    expect(bytesFor(classOnly, /runtime[/\\]attr\.js$/)).toBe(0);
    expect(bytesFor(classOnly, /url-policy\.js$/)).toBe(0);
    expect(bytesFor(classOnly, /attribute-policy\.js$/)).toBe(0);
    expect(bytesFor(classOnly, /runtime[/\\]class\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(withAttribute, /runtime[/\\]attr\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(withAttribute, /url-policy\.js$/)).toBeGreaterThan(0);
  }, 60_000);

  // 073 moved a lightweight branch's setters into the generated module. A branch that only interpolates text
  // therefore stops dragging the class, attribute, style, and event runtimes in behind the branch runtime.
  it("keeps a text-only conditional free of class, attribute, style, and event bytes", async () => {
    const textOnly = await buildClientBundle(
      generatedClientEntry(`<main><if test={open}><b>{label}</b></if></main>`, { reactive: true }),
      { cwd: process.cwd() },
    );
    const withSetters = await buildClientBundle(
      generatedClientEntry(
        `<main><if test={open}><b class:on={flag} title={tip} style:color={hue} on:click={save}>{label}</b></if></main>`,
        { reactive: true },
      ),
      { cwd: process.cwd() },
    );

    expect(bytesFor(textOnly, /runtime[/\\]class\.js$/)).toBe(0);
    expect(bytesFor(textOnly, /runtime[/\\]attr\.js$/)).toBe(0);
    expect(bytesFor(textOnly, /runtime[/\\]event\.js$/)).toBe(0);
    expect(bytesFor(textOnly, /runtime[/\\]conditional-core\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(withSetters, /runtime[/\\]class\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(withSetters, /runtime[/\\]attr\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(withSetters, /runtime[/\\]event\.js$/)).toBeGreaterThan(0);
  }, 60_000);

  // A row that a generated list drives has to carry its own setters and binders, the way a generated branch
  // already does. Otherwise the generic keyed list statically imports every binding runtime, and a list of rows
  // that only hold a ref and some text drags the branch runtime, the form runtime, the class setter, and the
  // URL sanitizer behind it.
  it("keeps a generated keyed list free of the runtimes its rows never use", async () => {
    const plainRows = await buildClientBundle(
      generatedClientEntry(`<ul><for each={rows} key={row.id}><li ref={row.node}>{row.label}</li></for></ul>`, {
        reactive: true,
      }),
      { cwd: process.cwd() },
    );
    const richRows = await buildClientBundle(
      generatedClientEntry(
        `<ul><for each={rows} key={row.id}><li class:on={row.on} title={row.tip}><input bind:value={row.draft}><if test={row.open}><b>{row.label}</b></if></li></for></ul>`,
        { reactive: true },
      ),
      { cwd: process.cwd() },
    );

    expect(bytesFor(plainRows, /runtime[/\\]list\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(plainRows, /runtime[/\\]conditional\.js$/)).toBe(0);
    expect(bytesFor(plainRows, /runtime[/\\]conditional-core\.js$/)).toBe(0);
    expect(bytesFor(plainRows, /runtime[/\\]form\.js$/)).toBe(0);
    expect(bytesFor(plainRows, /runtime[/\\]class\.js$/)).toBe(0);
    expect(bytesFor(plainRows, /url-policy\.js$/)).toBe(0);
    expect(bytesFor(plainRows, /attribute-policy\.js$/)).toBe(0);
    // The rows that do use them still get them.
    expect(bytesFor(richRows, /runtime[/\\]form\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(richRows, /runtime[/\\]class\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(richRows, /url-policy\.js$/)).toBeGreaterThan(0);
    expect(
      bytesFor(richRows, /runtime[/\\]conditional\.js$/) + bytesFor(richRows, /runtime[/\\]conditional-core\.js$/),
    ).toBeGreaterThan(0);
  }, 60_000);

  // The branch runtime had the same alias in place of a split, so a branch the generic entry drives - one with
  // a store, a ref, or a nested region - pulled every setter, the form runtime, and the whole keyed list in
  // behind it, whatever the branch actually held.
  it("keeps a generated branch free of the runtimes its bindings never use", async () => {
    const storeBranch = await buildClientBundle(
      generatedClientEntry(`<main><if test={open}><store draft={seed}/><b>{draft}</b></if></main>`, {
        reactive: true,
      }),
      { cwd: process.cwd() },
    );
    const listBranch = await buildClientBundle(
      generatedClientEntry(
        `<main><if test={open}><ul><for each={rows} key={row.id}><li ref={row.node}>{row.label}</li></for></ul></if></main>`,
        { reactive: true },
      ),
      { cwd: process.cwd() },
    );

    expect(bytesFor(storeBranch, /runtime[/\\]conditional\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(storeBranch, /runtime[/\\]list\.js$/)).toBe(0);
    expect(bytesFor(storeBranch, /runtime[/\\]form\.js$/)).toBe(0);
    expect(bytesFor(storeBranch, /runtime[/\\]class\.js$/)).toBe(0);
    expect(bytesFor(storeBranch, /url-policy\.js$/)).toBe(0);
    expect(bytesFor(storeBranch, /runtime[/\\]hydrate\.js$/)).toBe(0);
    // A branch that does hold a list gets the list, and still nothing else.
    expect(bytesFor(listBranch, /runtime[/\\]list\.js$/)).toBeGreaterThan(0);
    expect(bytesFor(listBranch, /runtime[/\\]form\.js$/)).toBe(0);
    expect(bytesFor(listBranch, /url-policy\.js$/)).toBe(0);
  }, 60_000);

  it("records actual bytesInOutput contributions per output", () => {
    expect(
      attributionForMetafile({
        inputs: {
          "dist/runtime/signal.js": { bytes: 100 },
          "dist/runtime/text.js": { bytes: 50 },
        },
        outputs: {
          "out.js": {
            bytes: 200,
            inputs: {
              "dist/runtime/signal.js": { bytesInOutput: 37 },
              "dist/runtime/text.js": { bytesInOutput: 11 },
            },
          },
        },
      }),
    ).toEqual({
      outputs: [
        {
          path: "out.js",
          bytes: 200,
          inputs: [
            { path: "dist/runtime/signal.js", bytesInOutput: 37 },
            { path: "dist/runtime/text.js", bytesInOutput: 11 },
          ],
        },
      ],
      inputs: [
        { path: "dist/runtime/signal.js", bytesInOutput: 37 },
        { path: "dist/runtime/text.js", bytesInOutput: 11 },
      ],
    });
  });

  it("rejects forbidden inputs and budget overruns through explicit policy results", () => {
    expect(findForbiddenInputs(["dist/compiler/index.js", "dist/runtime/signal.js"])).toEqual([
      "dist/compiler/index.js",
    ]);
    expect(
      findUnwantedFeatureInputs([
        { path: "dist/runtime/list.js", bytesInOutput: 12 },
        { path: "dist/runtime/form.js", bytesInOutput: 0 },
      ]),
    ).toEqual([{ path: "dist/runtime/list.js", bytesInOutput: 12 }]);
    expect(
      checkBundleBudget({
        minifiedBytes: 101,
        brotliBytes: 10,
        budget: { maxMinifiedBytes: 100, maxBrotliBytes: 20 },
      }),
    ).toEqual({ ok: false, reason: "minified budget" });
    expect(
      checkBundleBudget({
        minifiedBytes: 100,
        brotliBytes: 21,
        budget: { maxMinifiedBytes: 100, maxBrotliBytes: 20 },
      }),
    ).toEqual({ ok: false, reason: "Brotli budget" });
  });

  it("requires every fixture to have a positive finite budget", () => {
    const fixtures = [{ name: "static" }, { name: "minimal-if" }];

    expect(validateFixtureBudgets({}, fixtures)).toMatchObject({ ok: false, reason: "missing fixture budget" });
    expect(
      validateFixtureBudgets(
        {
          static: { maxMinifiedBytes: 100, maxBrotliBytes: 100 },
          "minimal-if": { maxMinifiedBytes: 0, maxBrotliBytes: Number.POSITIVE_INFINITY },
        },
        fixtures,
      ),
    ).toMatchObject({ ok: false, reason: "invalid fixture budget" });
    expect(
      validateFixtureBudgets(
        {
          static: { maxMinifiedBytes: 100, maxBrotliBytes: 100 },
          "minimal-if": { maxMinifiedBytes: 200, maxBrotliBytes: 200 },
        },
        fixtures,
      ),
    ).toEqual({ ok: true });
  });

  it("fails the attribution runner when an unwanted feature contributes bytes", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "tachyon-client-bundles-policy-"));
    try {
      const fixtures = createClientBundleFixtures().map((fixture) =>
        fixture.name === "minimal-if"
          ? {
              ...fixture,
              entrySource: `${fixture.entrySource}
import { bindControl } from "./dist/runtime/form.js";
export const unwanted = bindControl;
`,
            }
          : fixture,
      );

      await expect(runClientBundleAttribution({ cwd: process.cwd(), artifactRoot, fixtures })).rejects.toThrow(
        /minimal-if.*unwanted feature/i,
      );
      const [runDirectory] = await readdir(artifactRoot);
      if (!runDirectory) throw new Error("Missing failed attribution run directory.");
      const failedReport = JSON.parse(await readFile(join(artifactRoot, runDirectory, "report.json"), "utf8")) as {
        validation: { ok: boolean; failures: string[] };
        fixtures: Array<{ name: string; minimalFeaturePolicy?: { ok: boolean; unwantedInputs: string[] } }>;
      };
      expect(failedReport.validation.ok).toBe(false);
      expect(failedReport.validation.failures.join("\n")).toMatch(/minimal-if.*unwanted feature/i);
      expect(
        failedReport.fixtures.find((fixture) => fixture.name === "minimal-if")?.minimalFeaturePolicy,
      ).toMatchObject({
        ok: false,
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("writes nine attributed fixtures with provenance and unique run artifacts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "tachyon-client-bundles-"));
    try {
      const first = await runClientBundleAttribution({ cwd: process.cwd(), artifactRoot });
      const second = await runClientBundleAttribution({ cwd: process.cwd(), artifactRoot });

      expect(first.artifactPath).not.toBe(second.artifactPath);
      const report = JSON.parse(await readFile(first.artifactPath, "utf8")) as {
        schemaVersion: number;
        runId: string;
        provenance: {
          head: string;
          lockfileSha256: string;
          node: string;
          pnpm: string;
          esbuild: string;
          zlib: string;
        };
        buildOptions: {
          define: Record<string, string>;
          minify: boolean;
          platform: string;
          brotli: { algorithm: string; params: Record<string, unknown> };
        };
        fixtures: Array<{
          name: string;
          sourceSha256: string;
          generatedSource: string;
          compileOptions: unknown;
          generateOptions: unknown;
          minifiedBytes: number;
          brotliBytes: number;
          inputs: Array<{ path: string; bytesInOutput: number }>;
          minimalFeaturePolicy?: { ok: boolean; unwantedInputs: string[] };
        }>;
      };

      expect(report.schemaVersion).toBe(1);
      expect(report.runId).toBe(first.runId);
      expect(report.provenance.head).toMatch(/^[a-f0-9]{40}$/);
      expect(report.provenance.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.provenance.node).toBe(process.version);
      expect(report.provenance.pnpm).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.provenance.esbuild).toBe("0.28.1");
      expect(report.provenance.zlib).toBe(process.versions.zlib);
      expect(report.buildOptions).toMatchObject({
        define: { __TACHYON_PRODUCTION__: "true" },
        minify: true,
        platform: "browser",
        brotli: { algorithm: "brotliCompressSync", params: {} },
      });
      expect(report.fixtures.map((fixture) => fixture.name)).toEqual([
        "static",
        "signal-only",
        "reactive-text",
        "event-only",
        "text-only-list",
        "minimal-if",
        "composite-quick-example",
        "one-template-page",
        "thirty-template-page",
      ]);
      // The many-template page shares the runtime with the one-template page, so it costs less than thirty
      // copies of it: the difference is what each additional template adds.
      const one = report.fixtures.find((fixture) => fixture.name === "one-template-page");
      const thirty = report.fixtures.find((fixture) => fixture.name === "thirty-template-page");
      if (!one || !thirty) throw new Error("Missing page fixtures.");
      expect(thirty.minifiedBytes).toBeGreaterThan(one.minifiedBytes);
      expect(thirty.minifiedBytes).toBeLessThan(one.minifiedBytes * 30);
      for (const fixture of report.fixtures) {
        expect(fixture.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(fixture.generatedSource.length).toBeGreaterThan(0);
        expect(fixture.minifiedBytes).toBeGreaterThan(0);
        expect(fixture.brotliBytes).toBeGreaterThan(0);
        expect(fixture.inputs.some((input) => input.bytesInOutput > 0)).toBe(true);
        expect(fixture.inputs.every((input) => !("brotliBytes" in input))).toBe(true);
      }
      expect(report.fixtures.find((fixture) => fixture.name === "reactive-text")?.generateOptions).toEqual({
        instrumentBindings: false,
        reactive: true,
      });
      expect(report.fixtures.find((fixture) => fixture.name === "composite-quick-example")?.compileOptions).toEqual({
        whitespace: "condense",
      });
      const minimalIf = report.fixtures.find((fixture) => fixture.name === "minimal-if");
      expect(minimalIf).toBeDefined();
      expect(minimalIf?.minimalFeaturePolicy?.ok).toBe(true);
      expect(minimalIf?.minimalFeaturePolicy?.unwantedInputs).toEqual([]);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
