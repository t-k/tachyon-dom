import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("benchmark GitHub Actions workflow", () => {
  it("手動Dispatchで2スイートとallを選択できる", async () => {
    const workflow = await readFile(".github/workflows/benchmarks.yml", "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("type: choice");
    expect(workflow).toContain("default: all");
    expect(workflow).toContain("- web-framework");
    expect(workflow).toContain("- js-framework");
    expect(workflow).not.toContain("schedule:");
  });

  it("選択したベンチマークを実行してSummaryへ追記する", async () => {
    const workflow = await readFile(".github/workflows/benchmarks.yml", "utf8");

    expect(workflow).toContain("pnpm bench:web-framework --output");
    expect(workflow).toContain("pnpm bench:local:stable --output");
    expect(workflow).toContain('pnpm bench:summary "${summary_args[@]}"');
    expect(workflow).not.toContain("pnpm bench:web-framework -- --output");
    expect(workflow).toContain('cat "$RESULT_DIR/summary.md" >> "$GITHUB_STEP_SUMMARY"');
    expect(workflow).toContain("playwright install --with-deps chromium");
  });

  it("失敗時も成果物を回収し、リポジトリへ書き込まない", async () => {
    const workflow = await readFile(".github/workflows/benchmarks.yml", "utf8");

    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("uses: actions/upload-artifact@v4");
    expect(workflow).toContain("if-no-files-found: warn");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("git push");
    expect(workflow).not.toContain("contents: write");
  });
});
