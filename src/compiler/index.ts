import { err, ok, type Result } from "../result";
import { createTemplateIr } from "./ir";
import { parseTemplate } from "./parser";
import { lowerClientTemplate } from "./targets/client";
import type { CompiledTemplate, CompilerError } from "./types";

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

export * from "./types";
export { generateClientModule } from "./targets/client";
export { generateServerModule, renderServerTemplate } from "./targets/server";
export { generateServerStreamModule } from "./targets/stream";
