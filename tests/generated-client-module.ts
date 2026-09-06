import * as attrRuntime from "../src/runtime/attr";
import * as classRuntime from "../src/runtime/class";
import * as conditionalRuntime from "../src/runtime/conditional";
import * as eventRuntime from "../src/runtime/event";
import * as formRuntime from "../src/runtime/form";
import * as hydrateRuntime from "../src/runtime/hydrate";
import * as listTextRuntime from "../src/runtime/list-text";
import * as listRuntime from "../src/runtime/list";
import type { ClientTemplateModule } from "../src/runtime/mount";
import * as signalRuntime from "../src/runtime/signal";
import * as storeRuntime from "../src/runtime/store";
import * as textRuntime from "../src/runtime/text";

const runtimeModules: Record<string, Record<string, unknown>> = {
  "tachyon-dom/runtime/attr": attrRuntime,
  "tachyon-dom/runtime/class": classRuntime,
  "tachyon-dom/runtime/conditional": conditionalRuntime,
  "tachyon-dom/runtime/event": eventRuntime,
  "tachyon-dom/runtime/form": formRuntime,
  "tachyon-dom/runtime/hydrate": hydrateRuntime,
  "tachyon-dom/runtime/list-text": listTextRuntime,
  "tachyon-dom/runtime/list": listRuntime,
  "tachyon-dom/runtime/signal": signalRuntime,
  "tachyon-dom/runtime/store": storeRuntime,
  "tachyon-dom/runtime/text": textRuntime,
};

/**
 * Evaluates generated client code against the real runtime modules by
 * resolving every `import { name as alias } from "tachyon-dom/runtime/..."`.
 */
export const evaluateGeneratedClientModule = (
  code: string,
  overrides: Record<string, Record<string, unknown>> = {},
): ClientTemplateModule<Record<string, unknown>> => {
  const names: string[] = [];
  const values: unknown[] = [];
  for (const match of code.matchAll(/^import \{([^}]*)\} from "([^"]+)";$/gm)) {
    const runtime = runtimeModules[match[2] as string];
    if (!runtime) throw new Error(`Unknown generated import ${match[2]}.`);
    for (const specifier of (match[1] as string).split(",")) {
      const [exported, alias] = specifier.trim().split(/\s+as\s+/);
      if (!exported) continue;
      names.push((alias ?? exported).trim());
      values.push(overrides[match[2] as string]?.[exported.trim()] ?? runtime[exported.trim()]);
    }
  }
  const executable = code
    .replace(/^import .*$/gm, "")
    .replace(/^export default /m, "return ")
    .replace(/^export const /gm, "const ");
  return new Function(
    ...names,
    `${executable}; return { templateHtml, hydrationBoundaries, hydrationDynamicAttributes, hydrationDynamicRegions, bind: typeof bind === "function" ? bind : undefined, hydrate: typeof hydrate === "function" ? hydrate : undefined };`,
  )(...values) as ClientTemplateModule<Record<string, unknown>>;
};
