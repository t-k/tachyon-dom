import { err, ok, type Result } from "../result.js";
import { createTemplateIr } from "./ir.js";
import { parseTemplate } from "./parser.js";
import { lowerClientTemplate } from "./targets/client.js";
import type { CompiledTemplate, CompilerError } from "./types.js";

export const compileTemplate = (source: string): Result<CompiledTemplate, CompilerError> => {
  const rootResult = parseTemplate(source);
  if (!rootResult.ok) {
    return err(rootResult.error);
  }
  const irResult = createTemplateIr(rootResult.value);
  if (!irResult.ok) {
    return err(irResult.error);
  }
  return ok({
    source,
    ir: irResult.value,
    root: irResult.value.root,
    client: lowerClientTemplate(irResult.value.root),
  });
};

export * from "./types.js";
export { generateClientModule } from "./targets/client.js";
export { generateServerModule, renderServerTemplate } from "./targets/server.js";
export { generateServerStreamModule } from "./targets/stream.js";
