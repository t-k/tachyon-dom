import { readFileSync } from "node:fs";

const base = JSON.parse(readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"));
export default {
  ...base,
  incremental: false,
  mutate: ["src/url-policy.ts", "src/server/html.ts", "src/compiler/ir.ts", "src/runtime/attr.ts"],
  htmlReporter: { fileName: "reports/mutation/security/index.html" },
  jsonReporter: { fileName: "reports/mutation/security/mutation.json" },
  vitest: { configFile: "vitest.security-mutation.config.ts", related: false },
};
