import { err, ok, type Result } from "../result.js";
import { createTemplateIr } from "./ir.js";
import { parseTemplate } from "./parser.js";
import { lowerClientTemplate } from "./targets/client.js";
import type { CompiledTemplate, CompilerError } from "./types.js";

const compileCacheLimit = 128;
const compileCache = new Map<string, Result<CompiledTemplate, CompilerError>>();

const rememberCompiledTemplate = (
  source: string,
  result: Result<CompiledTemplate, CompilerError>,
): Result<CompiledTemplate, CompilerError> => {
  if (compileCache.has(source)) {
    compileCache.delete(source);
  }
  compileCache.set(source, result);
  while (compileCache.size > compileCacheLimit) {
    const oldest = compileCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    compileCache.delete(oldest);
  }
  return result;
};

export const compileTemplate = (source: string): Result<CompiledTemplate, CompilerError> => {
  const cached = compileCache.get(source);
  if (cached) {
    compileCache.delete(source);
    compileCache.set(source, cached);
    return cached;
  }
  const rootResult = parseTemplate(source);
  if (!rootResult.ok) {
    return rememberCompiledTemplate(source, err(rootResult.error));
  }
  const irResult = createTemplateIr(rootResult.value);
  if (!irResult.ok) {
    return rememberCompiledTemplate(source, err(irResult.error));
  }
  return rememberCompiledTemplate(source, ok({
    source,
    ir: irResult.value,
    root: irResult.value.root,
    client: lowerClientTemplate(irResult.value.root),
  }));
};

export * from "./types.js";
export { generateClientModule } from "./targets/client.js";
export { compileServerTemplate, generateServerModule, renderServerTemplate } from "./targets/server.js";
export { generateServerStreamModule } from "./targets/stream.js";
