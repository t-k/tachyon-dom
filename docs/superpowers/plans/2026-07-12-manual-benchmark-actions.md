# 手動ベンチマークGitHub Actions実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `agent-dag` skill to implement this plan task-by-task (it decides whether to use subagents and builds a Single-Writer Agent DAG). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Actionsの手動DispatchでWeb Framework比較とjs-framework-benchmark準拠比較を選択実行し、総合・項目別の参考ランキングをSummaryへ表示する。

**Architecture:** 既存ランナーは測定とJSON保存だけを担当させ、純粋関数中心の`benchmark/summary`モジュールがJSON検証、順位計算、Markdown整形を行う。薄いCLIがファイルI/Oを担当し、単一ジョブのGitHub Actionsワークフローがスイート実行、Summary追記、Artifact保存を編成する。

**Tech Stack:** TypeScript、Vitest、tsx、GitHub Actions、Playwright Chromium、pnpm

---

## ファイル構成

- Create: `benchmark/summary/ranking.ts` — 指標方向を考慮した競技順位、最速比、幾何平均を計算する純粋関数
- Create: `benchmark/summary/markdown.ts` — Web Frameworkとローカル比較のJSONを検証し、Summary用Markdownを生成する
- Create: `benchmark/summary/cli.ts` — CLI引数、JSON読み込み、Markdownファイル出力を担当する
- Create: `tests/benchmark-summary.test.ts` — 順位計算、検証、Markdown出力の単体テスト
- Create: `tests/benchmark-workflow.test.ts` — 手動Dispatchワークフローの契約テスト
- Create: `.github/workflows/benchmarks.yml` — 手動ベンチマーク実行と成果物保存
- Modify: `package.json` — Summary生成用scriptを追加する
- Modify: `benchmark/README.md` — 手動実行、参考ランキング、Artifactの利用方法を英語で記載する
- Modify: `docs.local/logs/2026-07-12/2026-07-12-014-manual-benchmark-actions-design.md` — 実装と検証結果を追記する

### Task 1: 汎用ランキング計算

**Files:**

- Create: `benchmark/summary/ranking.ts`
- Create: `tests/benchmark-summary.test.ts`

- [ ] **Step 1: 小さい方が良い指標、大きい方が良い指標、同順位の失敗テストを書く**

```ts
import { describe, expect, it } from "vitest";
import { rankMetric } from "../benchmark/summary/ranking";

describe("benchmark Summary ranking", () => {
  it("小さい値を優位として競技順位と最速比を計算する", () => {
    expect(
      rankMetric(
        [
          { name: "slow", value: 20 },
          { name: "fast-a", value: 10 },
          { name: "fast-b", value: 10 },
          { name: "middle", value: 15 },
        ],
        "lower",
      ),
    ).toEqual([
      { name: "fast-a", value: 10, rank: 1, ratioToBest: 1 },
      { name: "fast-b", value: 10, rank: 1, ratioToBest: 1 },
      { name: "middle", value: 15, rank: 3, ratioToBest: 1.5 },
      { name: "slow", value: 20, rank: 4, ratioToBest: 2 },
    ]);
  });

  it("大きい値を優位として最速比を1以上に正規化する", () => {
    expect(rankMetric([{ name: "a", value: 200 }, { name: "b", value: 100 }], "higher")).toEqual([
      { name: "a", value: 200, rank: 1, ratioToBest: 1 },
      { name: "b", value: 100, rank: 2, ratioToBest: 2 },
    ]);
  });

  it("空、非有限値、負値、大きい方が良い指標のゼロを拒否する", () => {
    expect(() => rankMetric([], "lower")).toThrow("at least one metric value");
    expect(() => rankMetric([{ name: "a", value: Number.NaN }], "lower")).toThrow("finite");
    expect(() => rankMetric([{ name: "a", value: -1 }], "lower")).toThrow("non-negative");
    expect(() => rankMetric([{ name: "a", value: 0 }], "higher")).toThrow("positive");
  });
});
```

- [ ] **Step 2: テストがモジュール未存在で失敗することを確認する**

Run: `pnpm vitest run tests/benchmark-summary.test.ts`

Expected: FAIL with `Failed to resolve import "../benchmark/summary/ranking"`

- [ ] **Step 3: 最小の順位計算を実装する**

```ts
export type MetricDirection = "lower" | "higher";
export type MetricValue = { name: string; value: number };
export type RankedMetric = MetricValue & { rank: number; ratioToBest: number };

export const rankMetric = (values: readonly MetricValue[], direction: MetricDirection): RankedMetric[] => {
  if (values.length === 0) throw new Error("Ranking requires at least one metric value.");
  for (const item of values) {
    if (!Number.isFinite(item.value)) throw new Error(`${item.name} must be finite.`);
    if (item.value < 0) throw new Error(`${item.name} must be non-negative.`);
    if (direction === "higher" && item.value === 0) throw new Error(`${item.name} must be positive.`);
  }
  const sorted = [...values].sort((left, right) =>
    direction === "lower" ? left.value - right.value : right.value - left.value,
  );
  const best = sorted[0]?.value as number;
  return sorted.map((item, index) => ({
    ...item,
    rank: index === 0 || item.value !== sorted[index - 1]?.value ? index + 1 : (sorted[index - 1] as RankedMetric).rank,
    ratioToBest: direction === "lower" ? (best === 0 ? (item.value === 0 ? 1 : Number.POSITIVE_INFINITY) : item.value / best) : best / item.value,
  }));
};
```

実装時は前行のrank参照で入力配列と出力配列を混同しないよう、`reduce`またはローカル`previousRank`を使って型安全に完成させる。`lower`で最良値が0かつ他値が正の場合は有限の最速比を定義できないため、0を含む比較自体を明示的エラーにする方へテストを調整する。

- [ ] **Step 4: 対象テストを通す**

Run: `pnpm vitest run tests/benchmark-summary.test.ts`

Expected: PASS

- [ ] **Step 5: ランキング計算をコミットする**

```bash
git add benchmark/summary/ranking.ts tests/benchmark-summary.test.ts
git commit -m "feat: add benchmark summary ranking"
```

### Task 2: JSON検証とMarkdown Summary生成

**Files:**

- Create: `benchmark/summary/markdown.ts`
- Modify: `tests/benchmark-summary.test.ts`

- [ ] **Step 1: Web Frameworkの総合表、項目別表、注意書きの失敗テストを書く**

テスト内に最小fixtureを作り、`formatBenchmarkSummary({ suite: "web-framework", webFramework: fixture })`が次を含むことを検証する。

```ts
expect(markdown).toContain("# Benchmark Results");
expect(markdown).toContain("参考ランキング");
expect(markdown).toContain("## Web Framework総合ランキング");
expect(markdown).toContain("## Web Framework項目別ランキング");
expect(markdown).toContain("### 静的リクエスト数/秒");
expect(markdown).toContain("| 1 | fast\\|framework | 200 req/s | 1.000x |");
expect(markdown).toContain("### 静的p95レイテンシ");
expect(markdown).toContain("| 1 | fast\\|framework | 2.00 ms | 1.000x |");
```

fixtureは`benchmark.name: "web-framework"`、`provenance.git.commit`、`provenance.runtime.node`、`provenance.host.platform`、`measurements.metrics`の8指標、`measurements.ranking`のscoreとrankを持たせる。

- [ ] **Step 2: js-frameworkの総合表、全操作、補助指標の失敗テストを書く**

`measurements.summaries`へ2実装×2シナリオの`trimmedMean`を、`auxiliaryMetrics`へ`mb`と`kib`を入れ、次を検証する。

```ts
expect(markdown).toContain("## js-framework-benchmark準拠比較 総合ランキング");
expect(markdown).toContain("### create rows");
expect(markdown).toContain("### partial update");
expect(markdown).toContain("### ready JS heap");
expect(markdown).toContain("### benchmark entry source size");
expect(markdown).toContain("tachyon-domリポジトリ内の比較");
```

総合値は各実装の操作別trimmed meanを、項目ごとの最良値で割った値の幾何平均とする。補助指標は総合値へ含めない。

- [ ] **Step 3: 不完全JSONとMarkdownエスケープの失敗テストを書く**

```ts
expect(() => formatBenchmarkSummary({ suite: "web-framework", webFramework: {} })).toThrow(
  "Invalid web-framework benchmark result",
);
expect(() => formatBenchmarkSummary({ suite: "js-framework", localCompare: {} })).toThrow(
  "Invalid local-compare benchmark result",
);
expect(() => formatBenchmarkSummary({ suite: "all", webFramework: webFixture })).toThrow(
  "requires both benchmark results",
);
```

- [ ] **Step 4: テストがexport未存在で失敗することを確認する**

Run: `pnpm vitest run tests/benchmark-summary.test.ts`

Expected: FAIL with missing `formatBenchmarkSummary`

- [ ] **Step 5: 検証、総合値、Markdown整形を実装する**

```ts
export type SummaryInput =
  | { suite: "web-framework"; webFramework: unknown }
  | { suite: "js-framework"; localCompare: unknown }
  | { suite: "all"; webFramework: unknown; localCompare: unknown };

export const escapeMarkdownCell = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]/g, " ").replaceAll("|", "\\|").trim();

export const formatBenchmarkSummary = (input: SummaryInput): string => {
  const sections = ["# Benchmark Results", "", "> この結果は単一Dispatch内の参考ランキングであり、権威的ランキングではありません。"];
  if (input.suite === "web-framework" || input.suite === "all") {
    sections.push(formatWebFrameworkSummary(parseWebFrameworkResult(input.webFramework)));
  }
  if (input.suite === "js-framework" || input.suite === "all") {
    sections.push(formatLocalCompareSummary(parseLocalCompareResult(input.localCompare)));
  }
  return `${sections.join("\n\n")}\n`;
};
```

`parseWebFrameworkResult`は8指標と総合scoreをすべて有限値として検証する。`parseLocalCompareResult`は全implementationが全scenarioと全auxiliary metricを1件ずつ持つことを検証する。見出しと名前は`escapeMarkdownCell`を通し、数値は`req/s`、`ms`、`MiB`、`KiB`、`count`で整形する。

- [ ] **Step 6: 対象テストを通す**

Run: `pnpm vitest run tests/benchmark-summary.test.ts`

Expected: PASS

- [ ] **Step 7: Summary生成ロジックをコミットする**

```bash
git add benchmark/summary/markdown.ts tests/benchmark-summary.test.ts
git commit -m "feat: format benchmark action summaries"
```

### Task 3: Summary CLIとpackage script

**Files:**

- Create: `benchmark/summary/cli.ts`
- Modify: `package.json`
- Modify: `tests/benchmark-summary.test.ts`

- [ ] **Step 1: CLI引数解析とファイル出力の失敗テストを書く**

CLIをspawnせずテストできるよう、`parseSummaryArgs`と`runSummaryCli`をexportする。

```ts
expect(parseSummaryArgs(["--suite", "all", "--web", "web.json", "--local", "local.json", "--output", "summary.md"])).toEqual({
  suite: "all",
  webPath: "web.json",
  localPath: "local.json",
  outputPath: "summary.md",
});
expect(() => parseSummaryArgs(["--suite", "unknown"])).toThrow("Unknown suite");
expect(() => parseSummaryArgs(["--suite", "all", "--web", "web.json"])).toThrow("--local is required");
```

一時ディレクトリへfixture JSONを書き、`runSummaryCli`後に`summary.md`が生成されることも検証する。

- [ ] **Step 2: テストがCLI未存在で失敗することを確認する**

Run: `pnpm vitest run tests/benchmark-summary.test.ts`

Expected: FAIL with missing CLI module

- [ ] **Step 3: CLIとpackage scriptを実装する**

```ts
export const runSummaryCli = async (argv: readonly string[]): Promise<void> => {
  const options = parseSummaryArgs(argv);
  const webFramework = options.webPath ? JSON.parse(await readFile(options.webPath, "utf8")) : undefined;
  const localCompare = options.localPath ? JSON.parse(await readFile(options.localPath, "utf8")) : undefined;
  const markdown = formatBenchmarkSummary(buildSummaryInput(options.suite, webFramework, localCompare));
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, markdown);
};
```

`package.json`へ次を追加する。

```json
"bench:summary": "tsx benchmark/summary/cli.ts"
```

`import.meta.url === pathToFileURL(process.argv[1] ?? "").href`の場合だけCLIを実行し、例外をstderrへ出して`process.exitCode = 1`にする。

- [ ] **Step 4: 対象テストと型チェックを通す**

Run: `pnpm vitest run tests/benchmark-summary.test.ts && pnpm exec tsc -p tsconfig.json --noEmit`

Expected: PASS and exit 0

- [ ] **Step 5: CLIをコミットする**

```bash
git add benchmark/summary/cli.ts tests/benchmark-summary.test.ts package.json
git commit -m "feat: add benchmark summary CLI"
```

### Task 4: 手動Dispatchワークフロー

**Files:**

- Create: `.github/workflows/benchmarks.yml`
- Create: `tests/benchmark-workflow.test.ts`

- [ ] **Step 1: ワークフロー契約の失敗テストを書く**

```ts
const workflow = await readFile(".github/workflows/benchmarks.yml", "utf8");
expect(workflow).toContain("workflow_dispatch:");
expect(workflow).toContain("default: all");
expect(workflow).toContain("- web-framework");
expect(workflow).toContain("- js-framework");
expect(workflow).toContain("pnpm bench:web-framework -- --output");
expect(workflow).toContain("pnpm bench:local:stable -- --output");
expect(workflow).toContain("pnpm bench:summary -- --suite");
expect(workflow).toContain('cat "$RESULT_DIR/summary.md" >> "$GITHUB_STEP_SUMMARY"');
expect(workflow).toContain("if: ${{ always() }}");
expect(workflow).toContain("uses: actions/upload-artifact@v4");
expect(workflow).not.toContain("git push");
expect(workflow).not.toContain("schedule:");
```

- [ ] **Step 2: テストがワークフロー未存在で失敗することを確認する**

Run: `pnpm vitest run tests/benchmark-workflow.test.ts`

Expected: FAIL with `ENOENT`

- [ ] **Step 3: 単一ジョブのワークフローを実装する**

ワークフローには次の契約をすべて明記する。

```yaml
name: Benchmarks

on:
  workflow_dispatch:
    inputs:
      suite:
        description: Benchmark suite to run
        required: true
        type: choice
        default: all
        options:
          - all
          - web-framework
          - js-framework

permissions:
  contents: read

concurrency:
  group: benchmarks-${{ github.ref }}
  cancel-in-progress: false
```

ジョブは`ubuntu-latest`、`timeout-minutes: 180`、Node 24、Corepack、`pnpm install --frozen-lockfile`、`pnpm exec playwright install --with-deps chromium`を使う。`$RUNNER_TEMP/tachyon-dom-benchmarks-${{ github.run_id }}`を`RESULT_DIR`へ設定する。

選択条件付きステップで次を実行する。

```bash
pnpm bench:web-framework -- --output "$RESULT_DIR/web-framework.json"
pnpm bench:local:stable -- --output "$RESULT_DIR/js-framework.json"
pnpm bench:summary -- --suite "${{ inputs.suite }}" --web "$RESULT_DIR/web-framework.json" --local "$RESULT_DIR/js-framework.json" --output "$RESULT_DIR/summary.md"
cat "$RESULT_DIR/summary.md" >> "$GITHUB_STEP_SUMMARY"
```

CLIには選択スイートで必要なパスだけ渡すよう、Summaryステップのbashで引数配列を組み立てる。Artifactは`if: ${{ always() }}`と`if-no-files-found: warn`を指定する。

- [ ] **Step 4: ワークフローテストを通す**

Run: `pnpm vitest run tests/benchmark-workflow.test.ts`

Expected: PASS

- [ ] **Step 5: YAMLと式展開を目視検証してコミットする**

Run: `sed -n '1,260p' .github/workflows/benchmarks.yml && git diff --check`

Expected: 3選択肢、条件付き実行、Summary追記、常時Artifactアップロードが確認でき、`git diff --check`がexit 0

```bash
git add .github/workflows/benchmarks.yml tests/benchmark-workflow.test.ts
git commit -m "ci: add manual benchmark workflow"
```

### Task 5: ドキュメントと総合検証

**Files:**

- Modify: `benchmark/README.md`
- Modify: `docs.local/logs/2026-07-12/2026-07-12-014-manual-benchmark-actions-design.md`

- [ ] **Step 1: 公開ドキュメントを英語で更新する**

`benchmark/README.md`へ`Manual GitHub Actions runs`節を追加し、ActionsのRun workflowから3スイートを選べること、結果が参考ランキングであること、SummaryとArtifactの場所、`js-framework`が上流公式ランナーではなく準拠比較であることを記載する。

- [ ] **Step 2: 全テスト、型、Lint、format検査を実行する**

Run: `pnpm test && pnpm exec tsc -p tsconfig.json --noEmit && pnpm lint && pnpm exec oxfmt --check benchmark/summary tests/benchmark-summary.test.ts tests/benchmark-workflow.test.ts .github/workflows/benchmarks.yml benchmark/README.md`

Expected: all commands exit 0

- [ ] **Step 3: js-framework smokeでJSONとSummaryを検証する**

Run: `tmpdir="$(mktemp -d)"; pnpm bench:local:smoke -- --output "$tmpdir/js-framework.json" && pnpm bench:summary -- --suite js-framework --local "$tmpdir/js-framework.json" --output "$tmpdir/summary.md" && sed -n '1,120p' "$tmpdir/summary.md"; rm -rf "$tmpdir"`

Expected: 全9操作の項目別ランキングと補助指標が表示され、コマンド終了後にVite、Chromium子プロセスが残らない

- [ ] **Step 4: Web Framework smokeでJSONとSummaryを検証する**

Run: `tmpdir="$(mktemp -d)"; pnpm bench:web-framework:smoke -- --output "$tmpdir/web-framework.json" && pnpm bench:summary -- --suite web-framework --web "$tmpdir/web-framework.json" --output "$tmpdir/summary.md" && sed -n '1,140p' "$tmpdir/summary.md"; rm -rf "$tmpdir"`

Expected: 総合ランキングと8項目のランキングが表示され、コマンド終了後にfixtureサーバー、Chromium、Node子プロセスが残らない

- [ ] **Step 5: プロセス衛生を確認する**

Run: `pgrep -af 'benchmark/(local-compare|web-framework)|chrome-headless|vite preview|vinxi start|next start' || true`

Expected: このタスクが起動したプロセスが0件。残存があればPIDごとに`ps -p <PID> -o pid,ppid,comm,args`で所有プロセスを確認してSIGTERMし、再確認する

- [ ] **Step 6: 作業ログへ変更、検証結果、制約を追記する**

`docs.local/logs/2026-07-12/2026-07-12-014-manual-benchmark-actions-design.md`へ実装ファイル、実行コマンド、結果、参考ランキングの制約を日本語で追記する。`docs.local`はignore対象なのでコミットには含めない。

- [ ] **Step 7: 最終変更をコミットする**

```bash
git add benchmark/README.md
git commit -m "docs: explain manual benchmark runs"
```

- [ ] **Step 8: 最終状態を確認する**

Run: `git status --short && git log -6 --oneline`

Expected: ユーザー既存の`docs/issues/`以外に未コミット変更がなく、設計・ランキング・Summary・CLI・ワークフロー・ドキュメントのコミットが確認できる
