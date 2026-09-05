import { err, ok, type Result } from "../result.js";
import { createTemplateIr } from "./ir.js";
import { parseTemplate } from "./parser.js";
import { lowerClientTemplate } from "./targets/client.js";
import type { CompiledTemplate, CompilerError } from "./types.js";
import type { CompileTemplateOptions, TemplateWhitespacePolicy } from "./types.js";
import { applyTemplateWhitespace } from "./whitespace.js";
import { normalizeHtmlTree } from "./html-tree.js";

const compileCacheLimit = 128;
const compileCache = new Map<string, Result<CompiledTemplate, CompilerError>>();

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const rememberCompiledTemplate = (
  cacheKey: string,
  result: Result<CompiledTemplate, CompilerError>,
): Result<CompiledTemplate, CompilerError> => {
  const frozenResult = deepFreeze(result);
  if (compileCache.has(cacheKey)) {
    compileCache.delete(cacheKey);
  }
  compileCache.set(cacheKey, frozenResult);
  while (compileCache.size > compileCacheLimit) {
    const oldest = compileCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    compileCache.delete(oldest);
  }
  return frozenResult;
};

export const compileTemplate = (
  source: string,
  options: CompileTemplateOptions = {},
): Result<CompiledTemplate, CompilerError> => {
  const whitespace: TemplateWhitespacePolicy = options.whitespace ?? "preserve";
  const cacheKey = `${whitespace}\0${source}`;
  const cached = compileCache.get(cacheKey);
  if (cached) {
    compileCache.delete(cacheKey);
    compileCache.set(cacheKey, cached);
    return cached;
  }
  const rootResult = parseTemplate(source);
  if (!rootResult.ok) {
    return rememberCompiledTemplate(cacheKey, err(rootResult.error));
  }
  const normalized = normalizeHtmlTree(applyTemplateWhitespace(rootResult.value, whitespace));
  if (!normalized.ok) {
    return rememberCompiledTemplate(cacheKey, err(normalized.error));
  }
  const root = normalized.value;
  const irResult = createTemplateIr(root);
  if (!irResult.ok) {
    return rememberCompiledTemplate(cacheKey, err(irResult.error));
  }
  return rememberCompiledTemplate(cacheKey, ok(deepFreeze({
    source,
    ir: irResult.value,
    root: irResult.value.root,
    client: lowerClientTemplate(irResult.value.root),
  })));
};

export * from "./types.js";
export { generateClientHydrationChunkModule, generateClientModule } from "./targets/client.js";
export {
  compileServerTemplate,
  generateServerModule,
  renderServerTemplate,
  type ServerModuleOptions,
} from "./targets/server.js";
export {
  generateServerStreamModule,
  validateServerStreamTemplate,
  type ServerStreamModuleOptions,
} from "./targets/stream.js";
