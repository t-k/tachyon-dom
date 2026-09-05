import { checkTachyonTemplateTypes } from "../dist/template-typecheck.js";

const valid = checkTachyonTemplateTypes(
  `<script lang="ts">\nexport const scope = () => ({ title: "Home", save: (_event: Event) => undefined });\n</script>\n<main><button on:click={save}>{title}</button></main>`,
  { fileName: "ci-valid.td" },
);
if (!valid.ok) throw new Error(valid.error);
if (valid.value.length > 0) {
  throw new Error(`Expected the valid template to have no diagnostics: ${JSON.stringify(valid.value)}`);
}

const invalid = checkTachyonTemplateTypes(
  `<script lang="ts">\nexport const scope = () => ({ title: "Home" });\n</script>\n<main>{missing}</main>`,
  { fileName: "ci-invalid.td" },
);
if (!invalid.ok) throw new Error(invalid.error);
if (!invalid.value.some((diagnostic) => diagnostic.code === 2339)) {
  throw new Error(`Expected TS2339 for the invalid template: ${JSON.stringify(invalid.value)}`);
}

console.log(`template typecheck: ${invalid.value.length} expected diagnostic(s)`);
