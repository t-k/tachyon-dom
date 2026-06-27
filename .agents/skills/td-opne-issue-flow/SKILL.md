---
name: td-opne-issue-flow
description: Use when handling Tachyon DOM docs.local/issues open items, triaging implementation gaps versus documentation gaps, resolving local issue files, checking similar regressions, preserving benchmarks, or finishing issue-driven changes.
---

# TD Open Issue Flow

## 目的

`/home/tk/work/tachyon-dom/docs.local/issues/open/`のissue対応を、実装ギャップ・設計/メンタルモデルギャップ・本当のdocument gapに切り分け、安全に修正して`closed`へ移すための手順。issueを閉じてよい根拠を作るために使う。

## 必須の併用

- 挙動変更なら`superpowers:test-driven-development`を使い、先にREDを作る。
- テスト観点を整理する場合は`coverage-ledger`を使い、Coverage Ledgerを作る。
- バグ対応で1回目の修正を外したら、調査用サブエージェントを立てる。広い調査や並列作業では先に`agent-dag`を使う。
- 曖昧な設計判断、性能、セキュリティ、難しいデバッグでは`candidate-tournament`を使う。
- 認証/認可、CSP/ヘッダ、入力検証、DB/クエリ、外部Webhook、ファイルアップロード、管理機能などセキュリティに影響する変更はSecurity Specialist観点で`Must Fix / Should Fix / Notes`を残す。
- HTML/CSSやクライアントJSのUI変更では最初に`modern-web-guidance`を使う。
- ブラウザ操作による確認が必要なら`agent-browser`を使う。
- 完了宣言前に`superpowers:verification-before-completion`を使う。

## 基本判断

- issue名や本文がdocument gapに見えても、まず「利用者は本当はこう動いてほしかった」という設計/メンタルモデルギャップではないかを疑う。
- 実装が期待挙動に寄せられるなら、docs追記だけで閉じない。実装・テスト・必要な最小docsを直す。
- 本当のdocument gapは、実装の挙動が妥当で、利用者の期待を変える説明が必要な場合だけ。公開ライブラリ向けのdocsやREADMEは英語で書く。作業ログなどローカル文書は日本語で書く。
- 性能に影響しそうな変更は、issue本文と既存benchmarkを読んでから同条件のbefore/afterを残す。`benchmark/**/results`は上書きせず、run単位で保存する。
- `docs.local/`はignore対象なので、issue移動と作業ログはローカル状態として扱い、通常のcommitには含めない。

## 手順

1. ルートで`git status --short --branch`を確認し、未追跡benchmark、ignored docs、他人の変更を触らない。
2. `date -Idate`で日付を確認し、`docs.local/logs/YYYY-MM-DD/YYYY-MM-DD-NNN-short-description.md`へ作業ログを作る。NNNは同日ディレクトリ内の次の連番にする。
3. `docs.local/issues/open/`の対象issueを読む。issueごとに「実装ギャップ」「設計/メンタルモデルギャップ」「document gap」「重複/既解決」を短く分類する。
4. 似た問題を`rg`で探す。compiler、runtime、router、server adapters、security headers、examples、benchmarksは複数経路がある前提で確認する。
5. 最小baselineを取る。依存関係が無ければ`pnpm install`を先に行う。
6. 実装ギャップはREDテストを追加し、期待どおり失敗することを確認してから実装する。Vitestを基本にし、E2Eが必要ならPlaywright Testを使う。
7. UI、hydration、DOM差分などjsdomで隠れる可能性があるものは、必要に応じて実ブラウザE2Eや生成物検証を追加する。
8. 性能-sensitiveなら修正前後を同じコマンド・同じbuild modeで測る。`pnpm bench:local:smoke`、`pnpm bench:local:gate`、`pnpm bench:web-framework:smoke`など既存scriptを優先する。
9. docsだけで閉じる場合でも、該当APIや挙動を確認し、必要ならdocsの検証コマンドを実行する。
10. 開発サーバー、Firebase Emulator、podmanなどを起動した場合は作業終了時に停止する。ゾンビ化させない。
11. 一貫した単位でcommitする。`docs.local`ログ、`docs.local/issues`移動、benchmark local results、ignored/local artifactsはstageしない。
12. 対応済みissueを`docs.local/issues/open/`から`docs.local/issues/closed/`へ移す。
13. 最後に関連テスト、`pnpm lint`、必要なら`pnpm test`と`pnpm build`を実行する。範囲を狭めた場合は理由をログとfinalに残す。

## よくある落とし穴

- issue名がdocument gapでもdocsだけ更新して閉じる。
- REDを見ずに実装し、あとから通るテストだけ足す。
- adapterやrouterの片方だけを直し、Workers/Node/Lambdaやdirect fetch pathの類似経路を見落とす。
- jsdomの成功だけで、実ブラウザhydration、event、form、CSSOM差分を固定しない。
- security headersや入力検証を変えたのにSecurity Specialist観点を残さない。
- 開発サーバーやbenchmark processを残したまま終了する。
- `docs.local/issues`や`docs.local/logs`をcommitしようとする。

## 最終報告に含めること

- 分類判断:実装修正、設計/メンタルモデル、docsだけ、重複/既解決。
- commit hash。
- `docs.local/issues/open`から`closed`へ移したissue。
- verificationのコマンドと結果。
- 性能計測をした場合はbefore/afterの保存先。計測不要と判断した場合は理由。
- Security Specialistレビューの有無と`Must Fix / Should Fix / Notes`要約。
- 停止した開発サーバーや、残した未追跡・ignored artifacts。
