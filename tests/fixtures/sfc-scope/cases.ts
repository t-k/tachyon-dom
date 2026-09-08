const internalHelpers = Array.from({ length: 24 }, (_, index) => `const internal${index} = ${index};`).join("\n");

export const sfcScopeCases = [
  {
    name: "direct-signal",
    script: 'const count = createSignal("READY"); const unused = 7;',
    expression: "count",
    narrows: false,
  },
  {
    name: "closure-helpers",
    script: `${internalHelpers}\nconst secret = "READY"; const label = () => secret;`,
    expression: "label()",
    narrows: true,
  },
  {
    name: "imported-function",
    script: 'import { importedLabel as label } from "./tests/fixtures/sfc-scope/shared.ts"; const secret = "READY";',
    expression: "label()",
    narrows: false,
  },
  {
    name: "this-method",
    script: 'const secret = "READY"; function label() { return this.secret; }',
    expression: "label()",
    narrows: false,
  },
  {
    name: "this-dynamic",
    script: 'const secret = "READY"; const key = "secret"; function label() { return this[key]; }',
    expression: "label()",
    narrows: false,
  },
  {
    name: "unicode",
    script: 'const 件数 = "READY"; const unused = 7;',
    expression: "件数",
    narrows: true,
  },
  {
    name: "escaped-name",
    script: 'const count = "READY"; const unused = 7;',
    expression: String.raw`\u0063ount`,
    narrows: true,
  },
  {
    name: "deferred-closure",
    script: 'const secret = "READY"; const label = () => secret;',
    expression: "label()",
    narrows: true,
    deferred: true,
  },
] as const;

export const sfcScopeSource = (fixture: (typeof sfcScopeCases)[number]): string => `<script setup>
${fixture.script}
import { createSignal } from "tachyon-dom/runtime/signal";
const clicks = createSignal(0);
const increment = () => clicks.set(clicks() + 1);
const readClicks = () => clicks();
const shown = true;
</script>
<main><if test={shown}><section ${"deferred" in fixture ? 'hydrate:id="panel" hydrate:interaction="click"' : ""}><p>{${fixture.expression}}</p><button on:click={increment}>{readClicks()}</button></section></if></main>`;
