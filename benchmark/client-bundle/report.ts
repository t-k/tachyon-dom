import type { FixtureMeasurement } from "./measure.js";

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(2)} KiB`;

const escapeCell = (value: string): string =>
  value
    .replaceAll("|", "\\|")
    .replaceAll(/[\r\n]+/g, " ")
    .trim();

export const formatClientBundleTable = (fixtures: readonly FixtureMeasurement[]): string => {
  const lines = [
    "| Fixture | JS raw | JS gzip | JS brotli | HTML gzip | Initial gzip | Initial brotli |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const fixture of fixtures) {
    lines.push(
      `| ${escapeCell(fixture.name)} | ${kib(fixture.javascript.rawBytes)} | ${kib(fixture.javascript.gzipBytes)} | ${kib(fixture.javascript.brotliBytes)} | ${kib(fixture.html.gzipBytes)} | ${kib(fixture.initial.gzipBytes)} | ${kib(fixture.initial.brotliBytes)} |`,
    );
  }
  return lines.join("\n");
};

export const formatClientBundleDescriptions = (fixtures: readonly FixtureMeasurement[]): string =>
  fixtures.map((fixture) => `- \`${escapeCell(fixture.name)}\`: ${escapeCell(fixture.description)}`).join("\n");
