import { performance } from "node:perf_hooks";
import { compileTemplate, generateClientModule } from "../../src/compiler";
import { compileTachyonSfc, sfcDefaultScopeName, transformSfcScript } from "../../src/compiler/sfc";

type CaseGroup = {
  name: string;
  run: () => void;
};

const templateSource = `<button on:click={increment} class:active={selected}>{count}</button>`;
const sfcSource = `<script>
export const pageTitle = "Counter";
export default {
  count: 1,
  increment: () => undefined,
  selected: false,
};
</script>
${templateSource}`;

const iterations = Number(process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1] ?? 20_000);
const maxTemplateRatio = Number(
  process.argv.find((arg) => arg.startsWith("--max-template-ratio="))?.split("=")[1] ?? "0",
);

const compileDirectTemplate = (): void => {
  const compiled = compileTemplate(templateSource);
  if (!compiled.ok) {
    throw new Error(compiled.error.message);
  }
  generateClientModule(compiled.value, { reactive: true });
};

const compileSfcTemplateOnly = (): void => {
  const compiled = compileTachyonSfc(templateSource);
  if (!compiled.ok) {
    throw new Error(compiled.error.message);
  }
  const script = transformSfcScript(compiled.value.descriptor.script);
  generateClientModule(compiled.value.template, {
    reactive: true,
    ...(script.defaultScopeName ? { defaultScopeName: sfcDefaultScopeName } : {}),
  });
};

const compileSfcWithScript = (): void => {
  const compiled = compileTachyonSfc(sfcSource);
  if (!compiled.ok) {
    throw new Error(compiled.error.message);
  }
  const script = transformSfcScript(compiled.value.descriptor.script);
  const moduleCode = `${script.code}${generateClientModule(compiled.value.template, {
    reactive: true,
    ...(script.defaultScopeName ? { defaultScopeName: sfcDefaultScopeName } : {}),
  })}`;
  if (moduleCode.length === 0) {
    throw new Error("Expected generated module code.");
  }
};

const groups: CaseGroup[] = [
  { name: "direct-template", run: compileDirectTemplate },
  { name: "sfc-template-only", run: compileSfcTemplateOnly },
  { name: "sfc-with-script", run: compileSfcWithScript },
];

const runGroup = (group: CaseGroup): { name: string; totalMs: number; opsPerSecond: number } => {
  for (let warmup = 0; warmup < 200; warmup++) {
    group.run();
  }
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    group.run();
  }
  const totalMs = performance.now() - started;
  return {
    name: group.name,
    opsPerSecond: iterations / (totalMs / 1_000),
    totalMs,
  };
};

const results = groups.map(runGroup);
const direct = results.find((result) => result.name === "direct-template")?.opsPerSecond ?? 1;
const templateOnly = results.find((result) => result.name === "sfc-template-only")?.opsPerSecond ?? 1;
const templateOnlyRatio = direct / templateOnly;

console.log(`Tachyon SFC transform benchmark (${iterations} iterations per group)`);
console.table(
  results.map((result) => ({
    case: result.name,
    "total ms": result.totalMs.toFixed(2),
    "ops/sec": Math.round(result.opsPerSecond),
    "vs direct": `${(direct / result.opsPerSecond).toFixed(3)}x`,
  })),
);

if (maxTemplateRatio > 0 && templateOnlyRatio > maxTemplateRatio) {
  throw new Error(`SFC template-only ratio ${templateOnlyRatio.toFixed(3)}x exceeded ${maxTemplateRatio.toFixed(3)}x.`);
}
