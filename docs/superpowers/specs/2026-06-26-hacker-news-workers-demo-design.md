# Hacker News Workersデモ設計

## 目的

`tachyon-dom`のSSR、streaming、Cloudflare Workers専用アダプタ、Cloudflare Assets bindingを実際に使うread-onlyのHacker Newsクローンを`examples/hacker-news`として追加する。実装は公開ライブラリのサンプルとして扱うため、サンプル内のREADMEや公開向け説明は英語にする。

## スコープ

- `/`でHacker News top storiesを表示する。
- Hacker News公式Firebase APIを利用する。
- ユーザー投稿、ログイン、投票、コメント投稿、検索は実装しない。
- コメント詳細ページは初回スコープ外とし、各記事は元URLまたはHN itemページへリンクする。
- Cloudflare Workersへデプロイできる構成を用意し、認証情報がある場合は`wrangler deploy`を試行する。

## アーキテクチャ

`examples/hacker-news`にWorker entry、SSRレンダラー、HN APIクライアント、CSS、README、Wrangler設定を置く。Worker entryは`tachyon-dom/adapters/workers`の`createWorkersHandler`を使う。HTMLルートは動的SSRとして処理し、CSSなどの静的ファイルは`env.ASSETS.fetch()`へ流す。

SSRは`tachyon-dom/router`の`renderRouteStream()`経由で行う。初期チャンクではアプリシェルとローディング状態を返し、HN APIから記事が取れたら後続チャンクでリストHTMLを返す。HN API取得に失敗した場合は、ページ全体を壊さずread-onlyのエラーパネルを返す。

## UI

HN本家に近い密度の高いニュースリストにするが、視認性は少し上げる。各行には順位、タイトル、ドメイン、スコア、投稿者、経過時間、コメント数を表示する。外部URLがないAsk HNなどはHN itemページへリンクする。

長いリストに備え、初期表示に入らない下位アイテムへ`content-visibility: auto`と`contain-intrinsic-size`を適用する。これはmodern-web-guidanceの`defer-rendering-heavy-content`に従い、初期表示に入る先頭アイテムには適用しない。

## データ

HN公式APIの`/v0/topstories.json`からID一覧を取得し、上位30件を`/v0/item/{id}.json`で取得する。APIレスポンスは実行時に最低限検証し、story/job/poll/ask相当の表示可能なitemだけをリストに出す。API取得には短いタイムアウトを設け、Cloudflare上で長くぶら下がらないようにする。

## Cloudflare

`examples/hacker-news/wrangler.jsonc`を追加する。新規Wrangler設定はCloudflare推奨に合わせてJSONCにする。`assets.directory`でビルド済み静的ファイルを指定し、`assets.binding`は`ASSETS`にする。デプロイは`pnpm example:hacker-news:deploy`で`wrangler deploy --config examples/hacker-news/wrangler.jsonc`を実行する。

## テスト

TDDで以下を実装する。

- HN APIクライアントがtop story IDsとitem JSONを表示用モデルへ変換する。
- 無効なitemや欠損タイトルを除外する。
- SSRがニュースリストHTMLを返す。
- streamingがシェルチャンクとリストチャンクを順に返す。
- WorkerがHTMLルートを動的に返し、asset pathはAssets bindingへ流す。
- HN API失敗時にエラーパネルHTMLを返す。

## セキュリティ

HN APIの`title`、`by`、`url`、`text`など外部由来データはHTMLエスケープする。外部URLは`http:`または`https:`だけリンクとして許可し、それ以外はHN itemページにフォールバックする。Workerレスポンスには`createSecurityHeaders()`の防御的ヘッダを適用する。実装後、Security Specialist観点でMust Fix / Should Fix / Notes形式のレビューを残す。
