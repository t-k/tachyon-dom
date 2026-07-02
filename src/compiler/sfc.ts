import * as ts from "typescript";
import { err, ok, type Result } from "../result.js";
import { compileTemplate } from "./index.js";
import type { CompiledTemplate, CompilerError } from "./types.js";

export const sfcDefaultScopeName = "__tachyonSfcDefaultScope";
export const sfcNamedScopeName = "__tachyonSfcScope";
export const sfcSetupScopeName = "__tachyonSfcSetupScope";

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
  setupBindings: string[];
};

const scriptOpenPattern = /<script\b([^>]*)>/gi;
const autoImports: Record<string, string> = {
  batch: "tachyon-dom",
  compileTachyonSfc: "tachyon-dom",
  createClientRouter: "tachyon-dom",
  createMemo: "tachyon-dom",
  createSignal: "tachyon-dom",
  createStore: "tachyon-dom",
  effect: "tachyon-dom",
  enhanceForm: "tachyon-dom",
  err: "tachyon-dom",
  generateClientModule: "tachyon-dom",
  generateServerStreamModule: "tachyon-dom",
  ok: "tachyon-dom",
  readTextStreamChunks: "tachyon-dom",
  renderServerTemplate: "tachyon-dom",
  renderToReadableStream: "tachyon-dom",
  validateFormData: "tachyon-dom",
};
const autoImportPattern = new RegExp(
  `\\b(?:${Object.keys(autoImports)
    .map((name) => name.replaceAll("$", "\\$"))
    .join("|")})\\b`,
);

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

const attrValue = (attrs: string, name: string): string | undefined => {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(attrs);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const hasBooleanAttr = (attrs: string, name: string): boolean =>
  new RegExp(`(?:^|\\s)${name}(?:\\s|=|$)`, "i").test(attrs);

export const sfcScriptLanguage = (script: TachyonSfcScript | undefined): "js" | "ts" => {
  const lang = attrValue(script?.attrs ?? "", "lang")?.toLowerCase();
  return lang === "ts" || lang === "typescript" ? "ts" : "js";
};

export const isSfcSetupScript = (script: TachyonSfcScript | undefined): boolean =>
  hasBooleanAttr(script?.attrs ?? "", "setup");

const sourceFileFor = (source: string, script: TachyonSfcScript | undefined): ts.SourceFile =>
  ts.createSourceFile(
    sfcScriptLanguage(script) === "ts" ? "component.td.ts" : "component.td.js",
    source,
    ts.ScriptTarget.ES2022,
    true,
    sfcScriptLanguage(script) === "ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );

const compilerErrorFromDiagnostic = (diagnostic: ts.Diagnostic, script: TachyonSfcScript): CompilerError => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return {
    message,
    offset: script.offset + (typeof diagnostic.start === "number" ? diagnostic.start : 0),
  };
};

const transpileScriptContent = (script: TachyonSfcScript): Result<string, CompilerError> => {
  const language = sfcScriptLanguage(script);
  if (language === "js") {
    return ok(script.content.trim());
  }
  const result = ts.transpileModule(script.content, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
      verbatimModuleSyntax: true,
    },
    fileName: "component.td.ts",
    reportDiagnostics: true,
  });
  const diagnostic = result.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostic) {
    return err(compilerErrorFromDiagnostic(diagnostic, script));
  }
  return ok(result.outputText.trim());
};

const addBindingNames = (name: ts.BindingName, names: Set<string>): void => {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      addBindingNames(element.name, names);
    }
  }
};

const topLevelBindings = (script: TachyonSfcScript | undefined): string[] => {
  if (!script) {
    return [];
  }
  const names = new Set<string>();
  const sourceFile = sourceFileFor(script.content, script);
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, names);
      }
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) {
        names.add(statement.name.text);
      }
    }
  }
  return Array.from(names).sort();
};

const isDeclarationName = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && !parent.name.getText().startsWith("{")) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
  );
};

const collectScriptIdentifiers = (
  source: string,
  script: TachyonSfcScript | undefined,
): { declared: Set<string>; referenced: Set<string> } => {
  const declared = new Set<string>();
  const referenced = new Set<string>();
  const sourceFile = sourceFileFor(source, script);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) {
        declared.add(clause.name.text);
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          declared.add(clause.namedBindings.name.text);
        } else {
          for (const specifier of clause.namedBindings.elements) {
            declared.add(specifier.name.text);
          }
        }
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      addBindingNames(node.name, declared);
    } else if (ts.isParameter(node)) {
      addBindingNames(node.name, declared);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      declared.add(node.name.text);
    } else if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      referenced.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { declared, referenced };
};

const autoImportScriptHelpers = (code: string, script: TachyonSfcScript | undefined): string => {
  if (!autoImportPattern.test(code)) {
    return code;
  }
  const identifiers = collectScriptIdentifiers(code, script);
  const importsByModule = new Map<string, string[]>();
  for (const [name, module] of Object.entries(autoImports)) {
    if (!identifiers.referenced.has(name) || identifiers.declared.has(name)) {
      continue;
    }
    importsByModule.set(module, [...(importsByModule.get(module) ?? []), name]);
  }
  if (importsByModule.size === 0) {
    return code;
  }
  const imports = Array.from(importsByModule)
    .map(([module, names]) => `import { ${names.sort().join(", ")} } from ${JSON.stringify(module)};`)
    .join("\n");
  return `${imports}\n${code}`;
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
      `const escapeScriptJson = (value) => value.replaceAll("<", "\\\\u003c").replaceAll(">", "\\\\u003e");`,
      `const escapeAttribute = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");`,
      `export const hydrationBoundaries = [];`,
      `export const renderHydrationState = (id, state) => '<script type="application/json" data-tachyon-state="' + escapeAttribute(id) + '">' + escapeScriptJson(JSON.stringify(state) ?? "null") + '</script>';`,
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

export const transformSfcScript = (
  script: TachyonSfcScript | undefined,
): Result<TransformedSfcScript, CompilerError> => {
  if (!script || script.content.trim().length === 0) {
    return ok({ code: "", setupBindings: [] });
  }
  const transpiled = transpileScriptContent(script);
  if (!transpiled.ok) {
    return err(transpiled.error);
  }
  const setupBindings = isSfcSetupScript(script) ? topLevelBindings(script) : [];
  const content = autoImportScriptHelpers(transpiled.value, script);
  if (isSfcSetupScript(script)) {
    const scopeEntries = setupBindings.map((name) => `${name}: ${name}`).join(", ");
    return ok({
      code: `${content}\nconst ${sfcSetupScopeName} = { ${scopeEntries} };\n`,
      defaultScopeName: sfcSetupScopeName,
      setupBindings,
    });
  }
  const namedScopeExport = /\bexport\s+const\s+scope\s*=/;
  const defaultExport = /\bexport\s+default\b/;
  if (namedScopeExport.test(content) && defaultExport.test(content)) {
    return err({ message: "Use either export const scope or export default, not both.", offset: script.offset });
  }
  if (namedScopeExport.test(content)) {
    const code = content.replace(namedScopeExport, `const ${sfcNamedScopeName} =`).trim();
    return ok({
      code: `${code}\nexport { ${sfcNamedScopeName} as scope };\n`,
      defaultScopeName: sfcNamedScopeName,
      setupBindings,
    });
  }
  if (!defaultExport.test(content)) {
    return ok({ code: `${content.trim()}\n`, setupBindings });
  }
  const code = content.replace(defaultExport, `const ${sfcDefaultScopeName} =`).trim();
  return ok({
    code: `${code}\nexport { ${sfcDefaultScopeName} as default };\n`,
    defaultScopeName: sfcDefaultScopeName,
    setupBindings,
  });
};

export const generateSfcScriptDeclarations = (script: TachyonSfcScript | undefined): Result<string, string> => {
  if (!script || script.content.trim().length === 0) {
    return ok("");
  }
  const result = ts.transpileDeclaration(script.content, {
    compilerOptions: {
      allowJs: true,
      declaration: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sfcScriptLanguage(script) === "ts" ? "component.td.ts" : "component.td.js",
  });
  if (result.outputText.trim().length === 0) {
    const diagnostic = result.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
    return err(
      diagnostic
        ? ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        : "Unable to emit script declarations.",
    );
  }
  return ok(result.outputText.trim());
};
