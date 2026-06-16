import { compileTemplate } from "./compiler/index";
import { err, ok, type Result } from "./result";
import type { CompiledTemplate } from "./compiler/types";

export type TemplateDiagnostic = {
  message: string;
  offset: number;
  line: number;
  column: number;
  sourceLine: string;
};

export const locateOffset = (source: string, offset: number): Omit<TemplateDiagnostic, "message" | "offset"> => {
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

export const diagnoseTemplate = (source: string): Result<CompiledTemplate, TemplateDiagnostic> => {
  const result = compileTemplate(source);
  if (result.ok) {
    return ok(result.value);
  }
  return err({
    message: result.error.message,
    offset: result.error.offset,
    ...locateOffset(source, result.error.offset),
  });
};

export const formatDiagnostic = (diagnostic: TemplateDiagnostic, file = "<template>"): string => {
  const pointer = `${" ".repeat(Math.max(0, diagnostic.column - 1))}^`;
  return `${file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}\n${diagnostic.sourceLine}\n${pointer}`;
};
