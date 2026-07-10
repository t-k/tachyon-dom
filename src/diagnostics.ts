import { compileTemplate } from "./compiler/index.js";
import { compileTachyonSfc } from "./compiler/sfc.js";
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

export const diagnoseTemplate = (source: string): Result<CompiledTemplate, TemplateDiagnostic> => {
  const result = compileTemplate(source);
  if (result.ok) {
    return ok(result.value);
  }
  return err(diagnosticFromCompilerError(source, result.error));
};

export const diagnoseTachyonSfc = (
  source: string,
  options: CompileTemplateOptions = {},
): Result<
  ReturnType<typeof compileTachyonSfc> extends Result<infer Value, CompilerError> ? Value : never,
  TemplateDiagnostic
> => {
  const result = compileTachyonSfc(source, options);
  if (result.ok) {
    return ok(result.value);
  }
  return err(diagnosticFromCompilerError(source, result.error));
};

export const formatDiagnostic = (diagnostic: TemplateDiagnostic, file = "<template>"): string => {
  const pointer = `${" ".repeat(Math.max(0, diagnostic.column - 1))}^`;
  return `${file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}\n${diagnostic.sourceLine}\n${pointer}`;
};
