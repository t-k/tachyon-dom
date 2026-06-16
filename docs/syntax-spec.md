# Tachyon DOM構文仕様

この文書はcompiler/runtime/SSRの契約を揺らさないための小さな構文仕様です。構文はHTML-firstを優先し、JavaScript式は属性値またはテキスト内の`{expr}`として扱います。現時点の式は識別子とドットパスに限定します。

## テキストバインディング

`{value}`はテキストノードの動的スロットです。client targetでは静的テンプレート内に空白テキストを残し、`runtime/text`で直接更新します。SSR targetではHTML escape済み文字列として出力します。

```html
<h1>{title}</h1>
```

## 条件分岐

`<if test={condition}>...</if>`は条件付きレンダリングです。client targetではコメントアンカーと`runtime/conditional`へのbindingになり、SSR/stream targetでは`test`がtruthyの場合だけ子を出力します。

```html
<if test="{active}">
  <button>{count}</button>
</if>
```

## keyed list

`<for each={items} key={item.id}>...</for>`はkeyed list boundaryです。`key`の先頭識別子がitem名になります。client targetでは親要素に対する`runtime/list` bindingになり、SSR/stream targetでは配列を順に出力します。

```html
<ul>
  <for each="{rows}" key="{row.id}">
    <li>{row.label}</li>
  </for>
</ul>
```

## store

`<store name={initial}/>`はDOMを出力しないstore定義です。client targetで`runtime/store`を必要な場合だけimportし、`createStore({ ...scope, name: scope.initial })`を生成します。

```html
<store count="{initialCount}" />
```

## event

`on:event={handler}`はイベントbindingです。client targetで`runtime/event`を必要な場合だけimportし、指定pathの要素へlistenerを復元します。SSR targetには出力しません。

```html
<button on:click="{increment}">{count}</button>
```

## component

`<component name="Name">...</component>`は透明なcomponent boundaryです。DOM要素としては出力せず、IRにcomponent directiveとして残します。現時点では1つのroot要素を持つcomponentを基本形とし、nested componentの境界確認と将来のcomponent target分割に使います。

```html
<component name="CounterPanel">
  <section>...</section>
</component>
```

## hydrate boundary

`hydrate:id={islandId}`はSSR済みHTMLとclient hydrationを接続するboundaryです。client templateからは属性を取り除き、SSR/stream targetでは`<!--tachyon-hydrate:<id>:start-->`と`<!--tachyon-hydrate:<id>:end-->`で対象要素を囲みます。client runtimeは`runtime/hydrate`でmarker pairを探し、既存DOMを置換せずにイベントとstate/list bindingだけを復元します。

```html
<section hydrate:id="{islandId}">
  <button>{count}</button>
</section>
```

## compiler pipeline

compilerは`HTML解析→Template IR→client target/SSR string target/SSR stream target`の順に処理します。`CompiledTemplate.ir.directives`には`store`、`component`、`hydrate`、`if`、`event`、`for`を明示的に記録し、各targetは同じIR rootとdirective契約を前提に出力します。
