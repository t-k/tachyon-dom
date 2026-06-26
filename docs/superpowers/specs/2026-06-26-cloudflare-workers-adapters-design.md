# Cloudflare Workersアダプタ分離設計

## 背景

`tachyon-dom/adapters`には`createWorkersHandler`があるが、同じモジュール内にNode用の`node:http`、`node:fs/promises`、`node:path`、`node:stream`依存が混在している。また`src/router.ts`もファイルルート生成のために`node:fs/promises`と`node:path`をトップレベルでimportしている。そのためCloudflare Workers向けにSSR/ルーティングだけを使いたい場合でも、WorkerバンドルにNode依存が混入する可能性がある。

## 方針

Workers専用の`tachyon-dom/adapters/workers`を追加し、Web標準APIだけで`createWorkersHandler`を提供する。Node用の`createNodeHandler`とファイルシステムベースの静的アセット配信は`tachyon-dom/adapters/node`へ分離する。既存の`tachyon-dom/adapters`は互換用の集約エントリとして残す。

## Cloudflare Assets対応

Workers専用アダプタにCloudflare Assets bindingを扱う設定を追加する。`assets`オプションは`env.ASSETS`を既定のbinding名として解決できるようにし、必要なら`binding`を直接渡せるようにする。アセット応答にも既存のsecurity headersをマージする。

アセットは静的ルートより後、動的ルーターより前に処理する。`basePath`が指定された場合はそのパス配下だけをAssets bindingへ渡す。`basePath`がない場合は404応答を動的ルーターへフォールスルーさせる。

## RouterのNode依存分離

`src/router.ts`のルーティング実行部からトップレベルNode importを取り除く。ファイル走査が必要な`scanFileRoutes`だけ動的importでNode APIを読み込む。`createFileRouteManifest`は文字列ベースのパス正規化で実装し、Worker実行時にNode APIを必要としないようにする。

## テスト

TDDで以下を追加する。

- `tachyon-dom/adapters/workers`がCloudflare Assets bindingを`env.ASSETS`から解決し、security headersをマージする
- `basePath`に一致しないアセット設定は動的ルーターへフォールスルーする
- `tachyon-dom/adapters/workers`のソースに`node:` importが含まれない
- `src/router.ts`のトップレベルに`node:` importが含まれない

## 対象外

`tachyon-dom/cookies`の`node:crypto`利用は今回の対象外とする。Cloudflare WorkersでCookie署名をNode互換なしで使う場合は、別途Web Cryptoベースの実装を検討する。
