import { err, ok, type Result } from "../result";
import { compileTemplate } from "./index";
import type { CompiledTemplate, CompilerError } from "./types";

export const sfcDefaultScopeName = "__tachyonSfcDefaultScope";

export type TachyonSfcScript = {
  attrs: string;
  content: string;
  offset: number;
};

type TemplateRange = {
  generatedStart: number;
  originalStart: number;
  length: number;
};

export type TachyonSfcDescriptor = {
  template: string;
  script?: TachyonSfcScript;
  mapTemplateOffset: (offset: number) => number;
};

export type CompiledTachyonSfc = {
  descriptor: TachyonSfcDescriptor;
  template: CompiledTemplate;
};

export type TransformedSfcScript = {
  code: string;
  defaultScopeName?: string;
};

const scriptOpenPattern = /<script\b([^>]*)>/gi;

const mapGeneratedOffset = (ranges: readonly TemplateRange[], sourceLength: number, offset: number): number => {
  for (const range of ranges) {
    const rangeEnd = range.generatedStart + range.length;
    if (offset >= range.generatedStart && offset <= rangeEnd) {
      return range.originalStart + (offset - range.generatedStart);
    }
  }
  return sourceLength;
};

export const parseTachyonSfc = (source: string): Result<TachyonSfcDescriptor, CompilerError> => {
  const matches = Array.from(source.matchAll(scriptOpenPattern));
  if (matches.length === 0) {
    return ok({
      template: source,
      mapTemplateOffset: (offset) => offset,
    });
  }
  if (matches.length > 1) {
    return err({ message: "Only one <script> block is currently supported.", offset: matches[1]?.index ?? 0 });
  }

  const match = matches[0];
  const openStart = match?.index ?? 0;
  const openEnd = openStart + (match?.[0].length ?? 0);
  const closeStart = source.indexOf("</script>", openEnd);
  if (closeStart < 0) {
    return err({ message: "Missing closing </script> tag.", offset: openStart });
  }
  const closeEnd = closeStart + "</script>".length;
  const before = source.slice(0, openStart);
  const after = source.slice(closeEnd);
  const ranges: TemplateRange[] = [
    { generatedStart: 0, originalStart: 0, length: before.length },
    { generatedStart: before.length, originalStart: closeEnd, length: after.length },
  ];
  return ok({
    script: {
      attrs: match?.[1]?.trim() ?? "",
      content: source.slice(openEnd, closeStart),
      offset: openEnd,
    },
    template: `${before}${after}`,
    mapTemplateOffset: (offset) => mapGeneratedOffset(ranges, source.length, offset),
  });
};

export const compileTachyonSfc = (source: string): Result<CompiledTachyonSfc, CompilerError> => {
  const descriptor = parseTachyonSfc(source);
  if (!descriptor.ok) {
    return err(descriptor.error);
  }
  const template = compileTemplate(descriptor.value.template);
  if (!template.ok) {
    return err({
      message: template.error.message,
      offset: descriptor.value.mapTemplateOffset(template.error.offset),
    });
  }
  return ok({
    descriptor: descriptor.value,
    template: template.value,
  });
};

export const transformSfcScript = (script: TachyonSfcScript | undefined): TransformedSfcScript => {
  if (!script || script.content.trim().length === 0) {
    return { code: "" };
  }
  const defaultExport = /\bexport\s+default\b/;
  if (!defaultExport.test(script.content)) {
    return { code: `${script.content.trim()}\n` };
  }
  const code = script.content.replace(defaultExport, `const ${sfcDefaultScopeName} =`).trim();
  return {
    code: `${code}\nexport { ${sfcDefaultScopeName} as default };\n`,
    defaultScopeName: sfcDefaultScopeName,
  };
};
