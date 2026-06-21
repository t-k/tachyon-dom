import { err, ok, type Result } from "../result";
import { compileTemplate } from "./index";
import type { CompiledTemplate, CompilerError } from "./types";

export const sfcDefaultScopeName = "__tachyonSfcDefaultScope";
export const sfcNamedScopeName = "__tachyonSfcScope";

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
  scriptOnly: boolean;
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

const emptyTemplate = (source: string): CompiledTemplate => ({
  source,
  ir: {
    kind: "template",
    root: { type: "element", tagName: "template", attrs: [], children: [] },
    directives: [],
  },
  root: { type: "element", tagName: "template", attrs: [], children: [] },
  client: {
    bindings: [],
    components: [],
    hydrationBoundaries: [],
    stores: [],
    templateHtml: "",
  },
});

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
  const scriptOnly = Boolean(descriptor.value.script) && descriptor.value.template.trim().length === 0;
  if (scriptOnly) {
    return ok({
      descriptor: descriptor.value,
      scriptOnly: true,
      template: emptyTemplate(descriptor.value.template),
    });
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
    scriptOnly: false,
    template: template.value,
  });
};

export const generateScriptOnlyModule = (target: "client" | "server" | "stream"): string => {
  if (target === "server") {
    return [
      `const escapeScriptJson = (value) => value.replaceAll("<", "\\\\u003c").replaceAll("-->", "--\\\\>");`,
      `const escapeAttribute = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");`,
      `export const hydrationBoundaries = [];`,
      `export const renderHydrationState = (id, state) => '<script type="application/json" data-tachyon-state="' + escapeAttribute(id) + '">' + escapeScriptJson(JSON.stringify(state)) + '</script>';`,
      `export const render = () => "";`,
    ].join("\n");
  }
  if (target === "stream") {
    return `export const stream = async function* () {};\n`;
  }
  return [
    `export const templateHtml = "";`,
    `export const hydrationBoundaries = [];`,
    `export const componentBoundaries = [];`,
    `export const bind = () => undefined;`,
  ].join("\n");
};

export const transformSfcScript = (script: TachyonSfcScript | undefined): TransformedSfcScript => {
  if (!script || script.content.trim().length === 0) {
    return { code: "" };
  }
  const namedScopeExport = /\bexport\s+const\s+scope\s*=/;
  if (namedScopeExport.test(script.content)) {
    const code = script.content.replace(namedScopeExport, `const ${sfcNamedScopeName} =`).trim();
    return {
      code: `${code}\nexport { ${sfcNamedScopeName} as scope };\n`,
      defaultScopeName: sfcNamedScopeName,
    };
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
