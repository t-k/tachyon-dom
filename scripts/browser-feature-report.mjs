import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const featureNames = [
  "runtime/list",
  "runtime/generic-list",
  "runtime/form",
  "runtime/conditional",
  "runtime/generic-conditional",
  "runtime/router",
];
const start = "<!-- browser-feature-sizes:start -->";
const end = "<!-- browser-feature-sizes:end -->";

export const validateFeatureReport = (report) => {
  const provenance = report?.provenance;
  if (
    report?.schemaVersion !== 1 ||
    !provenance ||
    !provenance.commit ||
    typeof provenance.dirty !== "boolean" ||
    !provenance.node ||
    !provenance.esbuild ||
    provenance.minify !== true ||
    provenance.define?.__TACHYON_PRODUCTION__ !== "true" ||
    provenance.compression !== "node:brotli-default" ||
    !Array.isArray(report.fixtures) ||
    report.fixtures.length !== featureNames.length
  ) {
    throw new Error("Invalid browser feature measurement report.");
  }
  for (const name of featureNames) {
    const fixtures = report.fixtures.filter((fixture) => fixture.name === name);
    const fixture = fixtures[0];
    if (
      fixtures.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(fixture.inputHash) ||
      !Number.isSafeInteger(fixture.minifiedBytes) ||
      fixture.minifiedBytes <= 0 ||
      !Number.isSafeInteger(fixture.brotliBytes) ||
      fixture.brotliBytes <= 0
    ) {
      throw new Error(`Missing or invalid browser feature fixture: ${name}.`);
    }
  }
  return report;
};

export const renderFeatureTable = (report) => {
  validateFeatureReport(report);
  return [
    "Browser feature measurements (bytes):",
    "",
    "| Fixture | Minified | Brotli |",
    "| --- | ---: | ---: |",
    ...featureNames.map((name) => {
      const fixture = report.fixtures.find((entry) => entry.name === name);
      return `| ${name} | ${fixture.minifiedBytes} | ${fixture.brotliBytes} |`;
    }),
    "",
    "Source: [measurement JSON](../scripts/browser-feature-sizes.json). It records the commit, dirty state, input hashes, Node/esbuild versions, production define, minification, and Brotli conditions. `pnpm check:runtime-sizes` compares the input hashes, the byte counts, and the conditions needed to reproduce them: esbuild version, production define, minification, compression, and the Node major version that CI pins. The commit and dirty state are recorded for traceability but are not compared. CI uploads fresh reports as the browser-feature-measurements artifact. These feature fixtures differ from the client bundle attribution fixtures and Quick Example.",
  ].join("\n");
};

export const updateFeatureDocumentation = (source, report) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end);
  if (
    first < 0 ||
    last < first ||
    source.indexOf(start, first + start.length) >= 0 ||
    source.indexOf(end, last + end.length) >= 0
  ) {
    throw new Error("Missing or duplicate browser feature documentation markers.");
  }
  return source.slice(0, first + start.length) + "\n" + renderFeatureTable(report) + "\n" + source.slice(last);
};

// The checkout a measurement came from is volatile: commit and dirty state change on every edit and cannot
// invalidate identical bytes. The conditions that must hold for the bytes to be reproducible are compared
// instead. Node is compared by major version only because CI pins the major (Node 24) and not the patch
// release, while a major upgrade can move the bundled zlib/Brotli implementation.
const majorVersion = (version) => /^v?(\d+)/.exec(String(version))?.[1] ?? String(version);

export const reproducibilityConditions = (report) => ({
  nodeMajor: majorVersion(report.provenance.node),
  esbuild: report.provenance.esbuild,
  minify: report.provenance.minify,
  define: report.provenance.define,
  compression: report.provenance.compression,
});

export const checkFeatureMeasurements = (baseline, current) => {
  validateFeatureReport(baseline);
  validateFeatureReport(current);
  const before = reproducibilityConditions(baseline);
  const after = reproducibilityConditions(current);
  for (const field of Object.keys(before)) {
    const expected = JSON.stringify(before[field]);
    const actual = JSON.stringify(after[field]);
    if (expected !== actual) {
      throw new Error(
        `Changed browser feature build condition: ${field} ${expected} became ${actual}. Re-measure with pnpm update:runtime-sizes.`,
      );
    }
  }
  for (const name of featureNames) {
    const before = baseline.fixtures.find((fixture) => fixture.name === name);
    const after = current.fixtures.find((fixture) => fixture.name === name);
    for (const field of ["inputHash", "minifiedBytes", "brotliBytes"]) {
      if (before[field] !== after[field]) throw new Error(`Stale browser feature measurement: ${name} ${field}.`);
    }
  }
};

const pathArgument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : fallback;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = pathArgument("--baseline", fileURLToPath(new URL("./browser-feature-sizes.json", import.meta.url)));
  const docs = pathArgument("--docs", fileURLToPath(new URL("../docs/runtime.md", import.meta.url)));
  const report = JSON.parse(await readFile(baseline, "utf8"));
  const source = await readFile(docs, "utf8");
  const next = updateFeatureDocumentation(source, report);
  if (process.argv.includes("--write")) await writeFile(docs, next);
  else if (source !== next) throw new Error("Stale runtime documentation; run pnpm update:runtime-sizes.");
}
