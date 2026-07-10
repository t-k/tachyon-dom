# 5件の再open issue対応設計

## 目的

2026-07-11時点で再openされている5件について、個別の症状だけを塞ぐのではなく、compiler、app、streaming response、benchmark、static assetの各境界をfail-closedにする。既存の公開APIとlegacy benchmark artifactの互換性を維持しながら、Acceptance Criteriaを回帰テストで固定する。

対象issueは次の5件とする。

- `2026-07-10-benchmark-result-provenance.md`
- `2026-07-10-static-asset-canonical-containment.md`
- `2026-07-10-safe-html-minification.md`
- `2026-07-11-streaming-provisional-response-drops-authoritative-metadata.md`
- `2026-07-11-standard-app-template-whitespace-policy-not-applied.md`

## 設計方針

修正は境界契約をfail-closedに統一する。入力やresponse metadataが不完全な場合に安全な値を推測せず、比較を拒否するか、HTTP応答をcommitする前に確定させる。実装は単一writerで行い、各issueをTDDの独立したcommitとして完成させる。

今回、早期fallback専用の新しい公開API、HTML parser全体の置換、benchmark schema libraryの外部依存追加は行わない。PICTとproperty-based testingも未承認のため実行せず、境界表に基づくtable-driven testで必要な組み合わせを固定する。

## Compiler template whitespace

`TemplateWhitespacePolicy`の`condense`は、HTML parsing semantics上で内容を逐語的に保持すべき要素の子孫を変換しない。保護対象は既存の`pre`、`textarea`、`script`、`style`に加えて、`xmp`、`listing`、`plaintext`、`iframe`、`noembed`、`noframes`を含む保守的な集合とする。

保護判定はcompilerの共有template treeを変換する前に行うため、client、server、streamは同じ結果を使う。各要素について改行、インデント、directiveを含む内容が保持されることをtable-driven testで検証する。通常要素のformatting newlineは引き続きcondenseされ、inline separator、非ASCII空白、expression内の文字列は既存挙動を維持する。

## Benchmark provenance

schema v2 artifactは比較前に構造検証する。共通envelopeの必須fieldと、各comparatorが指定する必須比較pathについて、fieldの存在と値の基本型を検証する。双方で同じfieldが欠けていてもcompatibleとは判定しない。

比較結果は次の契約に従う。

- schema v2の必須field不足は`compatible: false`とする。
- schema v2ではない既存artifactは従来どおりlegacy incompleteとして扱う。
- 明示的に許可されたrevision差分だけをintentional differenceとして残す。
- runtime、host、dependencies、browser、workload controlの不足または不一致をauthoritative comparisonで拒否する。
- 複数runのaggregatorも同じvalidatorを利用し、不完全なschema v2を集計しない。

validatorはbenchmark内部の共有moduleに置く。local comparatorとaggregatorが同じ必須field定義を使用できる構成にし、validation logicを別々に増やさない。

## Standard app template whitespace

compiler sourceを変換する`TemplateWhitespacePolicy`と、完成済みdocument HTMLのtag内部を整形する`HtmlWhitespacePolicy`を別の概念として維持する。

`templateWhitespace`を`defineApp()`、`pagesFromRouteFiles()`、`loadRouteApp()`へ明示的に渡せるようにする。raw route sourceをcompileする`defineApp()`はそのpolicyを`compileTachyonSfc()`へ渡す。標準starterは1つのpolicy定数を`tachyonDom()`と`loadRouteApp()`の両方へ渡し、direct `.td` importとraw route compilationを一致させる。

`tachyonApp()`の`htmlWhitespace`はdocument shellの整形に引き続き使用し、`templateWhitespace`の代替にはしない。deprecatedな`minifyHtml`の互換性も維持する。

検証はdirect module、`defineApp()`、`loadRouteApp()`、packaged starter production buildを含む。SSR HTMLだけでなくhydration後のevent、text binding、keyed list更新が同じ構造で動作することを確認する。

## Streaming response metadata

status、redirect、cache policy、CSP、`Set-Cookie`、`Vary`をbodyより後に確定する現在のprovisional responseを廃止する。adapterへ`RouteStreamResult`を返す時点で、HTTP応答のcommitに必要なmetadataをauthoritativeにする。

現在のrendererはroute本体を最終的に文字列として生成しており、早期fallbackだけがloader完了前に送信される。loaderはredirect、error、route header、cache policyを変更できるため、安全なdefaultではloaderとcommit-critical metadataの確定を待つ。結果として、metadataが未確定なrouteのfallbackを先に送信しない。

この変更で次を保証する。

- delayed GET/HEAD redirectが正しいstatusと`Location`で返る。
- delayed `no-store`、private、public cache policyがprovisionalな`private`へ置き換わらない。
- routeのCSP、cookie、`Vary`、security headerが全adapterの実HTTP応答に残る。
- error、not found、middleware response、cancellationも最初のcommit後にstatusやheaderを変更しない。
- Node、Workers、Lambda proxy、Lambda streamingで同じmetadata契約を持つ。

明示的なprovisional streaming APIは今回追加しない。将来追加する場合は、後続処理がstatusとheaderを変更できないことを型とruntime validationで保証する別設計とする。

## Static asset traversal

現行実装の`[\\/]` separator検査とcanonical containmentは維持する。cross-platform adapter testへliteral backslashとpercent-encoded backslashのケースを追加し、dynamic handlerへfallthroughせず403になることを固定する。

新しいテストが現行実装で通る場合、実装変更は行わない。URL parserによるseparator正規化を含め、最終的なresponse contractを検証する。

## Error handlingと互換性

benchmark validation errorは欠落pathを示し、比較不能の理由を呼び出し側が記録できる形にする。既存のschema v1やenvelopeを持たないartifactを書き換えない。

whitespace policyのdefaultは`preserve`を維持する。新しいoptionを指定しない利用者のrender結果を変更しない。

streaming responseはmetadata安全性を優先するため、loader待機中のfallbackが早期送信されなくなる。body内容、最終status、headerはbuffered renderingと一致させる。既存の早期fallback timing testは新しい安全契約を表すtestへ置き換える。

## テストと検証

各修正は失敗する回帰テストを先に追加し、対象testが意図した理由で失敗することを確認してから最小実装を行う。

対象testは次を含む。

- compiler protected contextのclient/server/stream table
- benchmark schema v2の欠落、誤型、dirty/unavailable git、serialization、control mismatch、legacy artifact
- direct `.td`、`defineApp()`、`loadRouteApp()`、starter production hydration parity
- immediate/delayed GET/HEAD、redirect、error、fallback、cookie、CSP、`Vary`、cache policy、cancellationのadapter matrix
- literal/encoded backslash traversalのcross-platform adapter regression

各issueのtargeted test後にcommitし、最後に`pnpm lint`、`pnpm test`、`pnpm build`、package/exports/size checks、starter verification、production benchmark smokeを実行する。起動したserver、browser、port reservation、子processは検証終了時に停止する。

Security reviewは`Must Fix / Should Fix / Notes`形式で実施する。Must Fixが残る場合はmainへmergeせず、修正と再レビューを行う。最終diffはwriterの説明を渡さないclean-context code reviewにも通す。

## 完了条件

5件それぞれのAcceptance Criteriaとcoverage obligationがcommit済みtestへ対応し、全検証とSecurity reviewを通過した時点でissue fileを`docs.local/issues/closed`へ移動する。作業ログはrepository root側の`docs.local/logs/2026-07-11/`へ記録する。worktree branchをmainへfast-forwardまたは通常mergeし、main上で最終verificationを再実行して完了とする。
