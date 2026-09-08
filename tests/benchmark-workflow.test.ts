import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("benchmark GitHub Actions workflow", () => {
  it("offers both suites and all from a manual dispatch", async () => {
    const workflow = await readFile(".github/workflows/benchmarks.yml", "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("type: choice");
    expect(workflow).toContain("default: all");
    expect(workflow).toContain("- web-framework");
    expect(workflow).toContain("- js-framework");
    expect(workflow).not.toContain("schedule:");
  });

  it("runs the chosen benchmark and appends its summary to the run", async () => {
    const workflow = await readFile(".github/workflows/benchmarks.yml", "utf8");

    expect(workflow).toContain("pnpm bench:web-framework --output");
    expect(workflow).toContain("pnpm bench:local:stable --output");
    expect(workflow).toContain('pnpm bench:summary "${summary_args[@]}"');
    expect(workflow).not.toContain("pnpm bench:web-framework -- --output");
    expect(workflow).toContain('cat "$RESULT_DIR/summary.md" >> "$GITHUB_STEP_SUMMARY"');
    expect(workflow).toContain("playwright install --with-deps chromium");
  });

  it("collects the artifacts even on failure and writes nothing into the repository", async () => {
    const workflow = await readFile(".github/workflows/benchmarks.yml", "utf8");
    const actionReferences = Array.from(workflow.matchAll(/uses:\s+([^\s#]+)/g), (match) => match[1]);

    expect(workflow).toContain("if: ${{ always() }}");
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference ?? ""))).toBe(true);
    expect(workflow).toContain("if-no-files-found: warn");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("git push");
    expect(workflow).not.toContain("contents: write");
  });
});
