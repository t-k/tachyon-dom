import { compileTemplate } from "./compiler/index.js";
import { compileTachyonSfc } from "./compiler/sfc.js";
import { validateServerStreamTemplate } from "./compiler/targets/stream.js";
import { err, ok, type Result } from "./result.js";
import type { CompiledTemplate, CompilerError, CompileTemplateOptions } from "./compiler/types.js";

export type TemplateDiagnostic = {
  message: string;
  offset: number;
  endOffset: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  sourceLine: string;
};

export type DiagnoseOptions = CompileTemplateOptions & {
  target?: "client" | "server" | "stream";
};

export const locateOffset = (
  source: string,
  offset: number,
): { line: number; column: number; sourceLine: string } => {
  const before = source.slice(0, offset);
  const lines = before.split(/\r?\n/);
  const sourceLines = source.split(/\r?\n/);
  const line = lines.length;
  const column = (lines.at(-1)?.length ?? 0) + 1;
  return {
    line,
    column,
    sourceLine: sourceLines[line - 1] ?? "",
  };
};

export const diagnosticFromCompilerError = (source: string, error: CompilerError): TemplateDiagnostic => {
  const endOffset = error.endOffset ?? Math.min(source.length, error.offset + 1);
  const end = locateOffset(source, endOffset);
  return {
    message: error.message,
    offset: error.offset,
    endOffset,
    ...locateOffset(source, error.offset),
    endLine: end.line,
    endColumn: end.column,
  };
};

export const diagnoseTemplate = (
  source: string,
  options: DiagnoseOptions = {},
): Result<CompiledTemplate, TemplateDiagnostic> => {
  const { target, ...compileOptions } = options;
  const result = compileTemplate(source, compileOptions);
  if (result.ok) {
    if (target === "stream") {
      const validation = validateServerStreamTemplate(result.value);
      if (!validation.ok) return err(diagnosticFromCompilerError(source, validation.error));
    }
    return ok(result.value);
  }
  return err(diagnosticFromCompilerError(source, result.error));
};

export const diagnoseTachyonSfc = (
  source: string,
  options: DiagnoseOptions = {},
): Result<
  ReturnType<typeof compileTachyonSfc> extends Result<infer Value, CompilerError> ? Value : never,
  TemplateDiagnostic
> => {
  const { target, ...compileOptions } = options;
  const result = compileTachyonSfc(source, compileOptions);
  if (result.ok) {
    if (target === "stream") {
      const validation = validateServerStreamTemplate(result.value.template);
      if (!validation.ok) {
        const mappedError = {
          ...validation.error,
          offset: result.value.descriptor.mapTemplateOffset(validation.error.offset),
          ...(validation.error.endOffset === undefined
            ? {}
            : { endOffset: result.value.descriptor.mapTemplateOffset(validation.error.endOffset) }),
        };
        return err(diagnosticFromCompilerError(source, mappedError));
      }
    }
    return ok(result.value);
  }
  return err(diagnosticFromCompilerError(source, result.error));
};

export const formatDiagnostic = (diagnostic: TemplateDiagnostic, file = "<template>"): string => {
  const pointer = `${" ".repeat(Math.max(0, diagnostic.column - 1))}^`;
  return `${file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}\n${diagnostic.sourceLine}\n${pointer}`;
};
