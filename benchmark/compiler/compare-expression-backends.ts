import { performance } from "node:perf_hooks";
import { parseExpression, type ExpressionParserBackend } from "../../src/compiler/expression";

type CaseGroup = {
  name: string;
  backend: ExpressionParserBackend;
  expressions: string[];
};

const simpleExpressions = [
  "row.id",
  "row.label",
  "count + 1",
  'size + "px"',
  'selected ? label : "none"',
  "format(label)",
  "{ name: user.name, active: user.active }",
  "[row.id, row.label, count + 1]",
];

const expandedExpressions = [
  "user?.profile?.name ?? fallback",
  "items[index].label",
  "`Guest ${fallback}`",
  "rows[selectedIndex]?.label ?? `Row ${selectedIndex}`",
  "config[section]?.enabled ? labels[section] : `Disabled ${section}`",
];

const groups: CaseGroup[] = [
  { name: "native-simple", backend: "native", expressions: simpleExpressions },
  { name: "oxc-simple", backend: "oxc", expressions: simpleExpressions },
  { name: "auto-simple", backend: "auto", expressions: simpleExpressions },
  { name: "oxc-expanded", backend: "oxc", expressions: expandedExpressions },
  { name: "auto-expanded", backend: "auto", expressions: expandedExpressions },
];

const iterations = Number(process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1] ?? 50_000);

const runGroup = (group: CaseGroup): { name: string; totalMs: number; opsPerSecond: number; failures: number } => {
  let failures = 0;
  for (let warmup = 0; warmup < 1_000; warmup++) {
    for (const expression of group.expressions) {
      if (!parseExpression(expression, { backend: group.backend }).ok) {
        failures++;
      }
    }
  }
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const expression of group.expressions) {
      if (!parseExpression(expression, { backend: group.backend }).ok) {
        failures++;
      }
    }
  }
  const totalMs = performance.now() - started;
  const operations = iterations * group.expressions.length;
  return {
    failures,
    name: group.name,
    opsPerSecond: operations / (totalMs / 1_000),
    totalMs,
  };
};

const results = groups.map(runGroup);
const nativeSimple = results.find((result) => result.name === "native-simple")?.opsPerSecond ?? 1;

console.log(`Expression parser backend benchmark (${iterations} iterations per group)`);
console.table(
  results.map((result) => ({
    backend: result.name,
    "total ms": result.totalMs.toFixed(2),
    "ops/sec": Math.round(result.opsPerSecond),
    "vs native simple": `${(nativeSimple / result.opsPerSecond).toFixed(3)}x`,
    failures: result.failures,
  })),
);
