# 第6回レビュー残件7件の修正設計

## 目的

`docs.local/review/20260906-sixth-summary.md`で確認されたX1〜X7を、既存の同期mount・SSR採用・hydrate-only・diagnostics・benchmark契約を維持しながら解消する。S2の重複hydration marker拒否は維持し、不正なSSRを別の要素へbindする緩和は行わない。

## 対象範囲

対象は次の7件とする。

- X1:兄弟componentで同名のstoreが同じstate propertyを上書きする。
- X2:後続SSR行の検証前に先行行をbindし、失敗時に採用済みDOMを削除する。
- X3:eager binder自身の途中例外でmanual cleanupが返却前に失われる。
- X4:scheduler解除後にpending interactionのreplayが実行される。
- X5:直接compileでtemplateIdがなく、diagnosticsの匿名bindingを解決できない。
- X6:計装付き生成物をproduction defineでbundleしてもdiagnostics情報が残る。
- X7:metadata benchmarkの共通duration・heapが候補処理を計測せず、no-opの値になる。

046のproperty modelの期待値修正、例外messageのredaction、diagnostics登録表の保持上限、mount後の同一root hydrate契約は今回の7件に含めない。

## 採用方針

### X1:宣言identityとlexical scopeをcompiler/runtimeで共有する

storeとcomponent propへ、名前とは独立したcompiler生成の宣言キーを付ける。キーはlexical ownerのDOM pathと宣言順から決定し、同じ名前の宣言でも別キーになる。lowering時には各bindingへ、そのbindingから参照できるcomponent-local nameと宣言キーの対応を保持する。

生成client moduleはrootのstore stateを従来どおりinstanceごとに一度作る。そのstate内のcomponent-local slotは宣言キーで分離し、expressionはsource nameではなく解決済みslotへアクセスする。nested componentは親scopeを継承してから自身のpropとstoreを追加するため、shadowingは子slotへ解決される。

listとconditionalのruntime metadataにも同じ宣言キーを渡す。rowまたはvisible branchが作るlocal scopeはそのownerの寿命に属し、reorderでは再作成せず、remove・branch退出で破棄する。entryが作ったstateとscope contextはeager binderおよびhydration chunkへ渡し、chunk側でstore初期式を再評価しない。手書きのruntime metadataはキーがない場合に従来のnameをfallbackとして使う。

### X2:SSR採用を全体preflightと所有権付きrollbackに分ける

list updateの最初に、今回採用する全SSR rowについてmarkerの存在・重複・malformed・element範囲を検証する。この段階ではbinding、listener、loader、scheduler、state初期化を開始しない。全行が通過した後にrecordを作成し、boundaryをbind・scheduleする。

recordはcloneしたnodeとSSRから採用したnodeを区別して保持する。採用失敗またはbinding失敗時は新規cloneとその資源だけを解放し、採用済みSSR nodeはDOMから削除しない。S2のduplicate errorは`HydrationBoundaryError.kind`を含めて従来どおり返す。

### X3:eager bindingをbinder内部で例外安全にする

生成されたeager binderは、manual cleanupを配列へ追加する処理を一つのtry/catch境界で包む。listener・form binding・ref・effectなどを確保した後に式評価が失敗した場合、配列へ登録済みのcleanupを逆順で実行してから元の例外を再送出する。正常終了時は従来のcleanup関数を返し、createRootのowner cleanupとの二重解放は冪等性で防ぐ。

### X4:schedulerの世代をreplay継続へ渡す

各schedulerは有効状態または世代tokenを持つ。interaction発生後に返却済みの解除関数が呼ばれた場合、hydration Promiseが完了してもreplay callbackはtokenの有効性を満たさずcloneをdispatchしない。retryの再登録も解除済みschedulerでは行わない。handle自体のdisposeとは独立した公開scheduler解除を回帰対象にする。

### X5:直接compileへ決定的な匿名IDを与える

明示templateIdがない場合、template sourceの内容から決定的な匿名templateIdとsource revisionを生成する。IDには絶対パス、作業ディレクトリ、アプリ固有情報を含めない。同一sourceは同じIDを使い、異なるsourceは異なるIDになる。明示ID・revisionが指定された場合は既存契約を優先する。

### X6:production defineがinstrumentation分岐全体を静的除去できる形にする

`__TACHYON_PRODUCTION__`のdefineを生成コードのinstrumentation分岐へ直接適用し、production時にdiagnostics import、template ID、revision、span配列、binding location操作、register callがdead codeになる構造へ変更する。開発時はdefine未指定でもinstrumentationが有効であり、通常Vite productionが生成時点で計装を省く既存経路も維持する。受入テストはminify後の関数名だけでなく、指定したunique IDとspan定数、diagnostics操作の不在を確認する。

### X7:metadata benchmarkでparse・load・hydrateを分離する

metadata sampleの共通duration・heapは、current artifactとcompact artifactを実際のSSR markupへhydrateしてdisposeする候補処理を計測する。no-op計測は残さない。既存の`new Function`構築時間は`currentModuleParseDurationMs`・`compactModuleParseDurationMs`のようにparseと明示し、module import/evaluationはmodule load、実DOM消費はcurrent/compact hydrate metricとして分ける。既存のconsumer correctness oracleとartifact sizeは維持し、結果JSONは新しいrun idで保存して既存結果を上書きしない。

## 検証設計

各項目は最小のREDを追加してから実装する。手書きの回帰、実生成module、runtime、browserを重複ではなく異なる失敗層の検証として保持する。

| 対象 | REDの核 | GREENの受入条件 |
| --- | --- | --- |
| X1 | sibling componentの`count=1`と`count=2`が両方2になる | 出力が1と2になり、nested shadowing・2 mount instance・row/branch ownerが独立する |
| X2 | row aのbinding後にrow bのmissing markerでSSR nodeが消える | binding readは0回、元DOMとmarkerが完全保持され、duplicateは拒否される |
| X3 | event登録後のtext式例外でhydrate失敗し、再クリックでhandlerが呼ばれる | 失敗直後のlistener数が0で、再hydrate時に重複listenerもない |
| X4 | scheduler解除後のPromise完了でinteraction cloneが発生する | 解除後のcloneは0件で、handle disposeを併用しなくても成立する |
| X5 | templateIdなしの直接compileでlive effectのlookupが空になる | 匿名ID・revisionでsource spanが解決し、異なるsource間で衝突しない |
| X6 | production define後もunique template IDとspanがbundleに残る | diagnostics import・ID・span・enter/register処理がminified bundleから除去される |
| X7 | metadata sampleの共通計測が`undefined`のみを測る | 実hydrate・disposeを計測し、parse/load/hydrateのmetric名と値の意味が一致する |

共通検証は対象Vitest、property test、3ブラウザ、build、lint、template type、browser entry・feature budget、exports・package検証を順に実行する。X2〜X4はSSR・cleanup・schedulerの失敗経路をSecurity Specialist観点でも確認し、結果を`Must Fix / Should Fix / Notes`で作業ログへ残す。PICTやTLA+は今回の初回実装では実行せず、手書き義務と既存property回帰で不足が見つかった場合に別途提案する。

## 変更単位

tracked source/testは次のように小さくcommitする。

1. compilerの宣言キー・lexical scope・匿名diagnostics ID。
2. list全体preflightと採用node rollback。
3. eager binder cleanupとscheduler replay解除。
4. production instrumentation除去。
5. metadata benchmark metric修正。
6. docs、作業ログ、検証結果の整理。

各commit前に対象テストを実行し、docs.localのissue・log・benchmark resultはstageしない。open issueが空のため、実装開始時にX1〜X7のfollow-up issueをlocal openへ作成し、各受入条件を満たしたものだけclosedへ移す。
