import type { BindingName, Diagnostic, Expression, Identifier, Node, PropertyName, SourceFile } from "typescript";
import { requireOptionalPeer } from "../optional-peer.js";
import { err, ok, type Result } from "../result.js";
import { compileTemplate } from "./index.js";
import type { CompiledTemplate, CompilerError, CompileTemplateOptions } from "./types.js";

type TypeScriptModule = typeof import("typescript");

let loadedTypeScript: TypeScriptModule | undefined;

const ts = new Proxy({} as TypeScriptModule, {
  get: (_target, property) => {
    loadedTypeScript ??= requireOptionalPeer<TypeScriptModule>("typescript", "Tachyon SFC compilation");
    return Reflect.get(loadedTypeScript, property);
  },
});

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
  /** Every top-level `<script setup>` declaration and runtime import. */
  setupBindings: string[];
  /** The setup bindings the generated scope factory returns; equals `setupBindings` without template identifiers. */
  exposedBindings: string[];
};

export type TransformSfcScriptOptions = {
  /**
   * Identifiers that appear anywhere in the template text. When given, the setup factory exposes only the setup
   * bindings among them: an expression can only reach a scope value by naming it literally, so a name absent
   * from the template can never be read by a binding, handler, ref, hydration id, or store initializer.
   */
  templateIdentifiers?: ReadonlySet<string>;
};

const templateIdentifierPattern = /[A-Za-z_$][\w$]*/g;

/** Every identifier-shaped token in a template, over-approximating the names its expressions can reference. */
export const templateScopeIdentifiers = (template: string): Set<string> =>
  new Set(template.match(templateIdentifierPattern) ?? []);

const autoImports: Record<string, string> = {
  batch: "tachyon-dom",
  compileTachyonSfc: "tachyon-dom/compiler",
  createClientRouter: "tachyon-dom/runtime/router",
  createMemo: "tachyon-dom",
  createSignal: "tachyon-dom",
  createStore: "tachyon-dom",
  effect: "tachyon-dom",
  enhanceForm: "tachyon-dom",
  err: "tachyon-dom",
  generateClientModule: "tachyon-dom/compiler",
  generateServerStreamModule: "tachyon-dom/compiler",
  ok: "tachyon-dom",
  readTextStreamChunks: "tachyon-dom",
  renderServerTemplate: "tachyon-dom/compiler",
  renderToReadableStream: "tachyon-dom/server/stream",
  validateFormData: "tachyon-dom",
};
const autoImportPattern = new RegExp(
  `\\b(?:${Object.keys(autoImports)
    .map((name) => name.replaceAll("$", "\\$"))
    .join("|")})\\b`,
);
const scriptSyntaxCacheLimit = 128;
const jsSyntaxCache = new Map<string, { message: string; start: number } | null>();

const rememberJsSyntax = (
  source: string,
  diagnostic: { message: string; start: number } | null,
): { message: string; start: number } | null => {
  if (jsSyntaxCache.has(source)) jsSyntaxCache.delete(source);
  jsSyntaxCache.set(source, diagnostic);
  while (jsSyntaxCache.size > scriptSyntaxCacheLimit) {
    const oldest = jsSyntaxCache.keys().next().value;
    if (oldest === undefined) break;
    jsSyntaxCache.delete(oldest);
  }
  return diagnostic;
};

const jsSyntaxDiagnostic = (source: string): { message: string; start: number } | null => {
  if (jsSyntaxCache.has(source)) {
    return jsSyntaxCache.get(source) ?? null;
  }
  const result = ts.transpileModule(source, {
    compilerOptions: {
      allowJs: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "component.td.js",
    reportDiagnostics: true,
  });
  const diagnostic = result.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  return rememberJsSyntax(
    source,
    diagnostic
      ? {
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          start: diagnostic.start ?? 0,
        }
      : null,
  );
};

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
    hydrationDynamicRegions: [],
    hydrationDynamicRegionErrors: [],
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

const leadingTriviaEnd = (source: string): number => {
  let offset = 0;
  while (offset < source.length) {
    const whitespace = /^\s+/.exec(source.slice(offset));
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    if (!source.startsWith("<!--", offset)) break;
    const commentEnd = source.indexOf("-->", offset + 4);
    if (commentEnd < 0) break;
    offset = commentEnd + 3;
  }
  return offset;
};

const leadingScriptOpen = (source: string): { attrs: string; start: number; end: number } | undefined => {
  const start = leadingTriviaEnd(source);
  const prefix = /^<script\b/i.exec(source.slice(start));
  if (!prefix) return undefined;
  let quote: '"' | "'" | undefined;
  for (let index = start + prefix[0].length; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return {
        attrs: source.slice(start + prefix[0].length, index).trim(),
        start,
        end: index + 1,
      };
    }
  }
  return undefined;
};

const isComponentScript = (attrs: string): boolean => {
  if (hasBooleanAttr(attrs, "src")) return false;
  const type = attrValue(attrs, "type")?.trim().toLowerCase();
  return (
    type === undefined ||
    type === "" ||
    type === "module" ||
    type === "text/javascript" ||
    type === "application/javascript"
  );
};

export const sfcScriptLanguage = (script: TachyonSfcScript | undefined): "js" | "ts" => {
  const lang = attrValue(script?.attrs ?? "", "lang")?.toLowerCase();
  return lang === "ts" || lang === "typescript" ? "ts" : "js";
};

export const isSfcSetupScript = (script: TachyonSfcScript | undefined): boolean =>
  hasBooleanAttr(script?.attrs ?? "", "setup");

const unwrapStaticExpression = (node: Expression): Expression => {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return unwrapStaticExpression(node.expression);
  }
  return node;
};

const staticPropertyName = (name: PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
};

const staticExpressionValue = (input: Expression): Result<unknown, string> => {
  const node = unwrapStaticExpression(input);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return ok(node.text);
  if (ts.isNumericLiteral(node)) return ok(Number(node.text));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return ok(true);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return ok(false);
  if (node.kind === ts.SyntaxKind.NullKeyword) return ok(null);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const value = staticExpressionValue(node.operand);
    return value.ok && typeof value.value === "number" ? ok(-value.value) : err("Static scope has an invalid number.");
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) return err("Static scope does not support spread elements.");
      const value = staticExpressionValue(element);
      if (!value.ok) return value;
      values.push(value.value);
    }
    return ok(values);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return err("Static scope supports property assignments only.");
      const name = staticPropertyName(property.name);
      if (name === undefined) return err("Static scope has an unsupported property name.");
      const propertyValue = staticExpressionValue(property.initializer);
      if (!propertyValue.ok) return propertyValue;
      value[name] = propertyValue.value;
    }
    return ok(value);
  }
  return err("Static scope values must be literals, arrays, or object literals.");
};

export const extractStaticSfcScope = (source: string): Result<Record<string, unknown> | undefined, string> => {
  const descriptor = parseTachyonSfc(source);
  if (!descriptor.ok) return err(descriptor.error.message);
  const script = descriptor.value.script;
  if (!script) return ok(undefined);
  const sourceFile = sourceFileFor(script.content, script);
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "scope" || !declaration.initializer) continue;
      const initializer = unwrapStaticExpression(declaration.initializer);
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
        return err("SFC scope must be a function returning a static object or be supplied explicitly by defineApp().");
      }
      let returned: Expression | undefined;
      if (ts.isBlock(initializer.body)) {
        const returnStatement = initializer.body.statements.find(ts.isReturnStatement);
        returned = returnStatement?.expression;
      } else {
        returned = initializer.body;
      }
      if (!returned) return err("SFC scope must return a static object.");
      const value = staticExpressionValue(returned);
      if (!value.ok) return err(`${value.error} Supply page.scope explicitly for dynamic values.`);
      if (!value.value || typeof value.value !== "object" || Array.isArray(value.value)) {
        return err("SFC scope must return an object.");
      }
      return ok(value.value as Record<string, unknown>);
    }
  }
  return ok(undefined);
};

const sourceFileFor = (source: string, script: TachyonSfcScript | undefined): SourceFile =>
  ts.createSourceFile(
    sfcScriptLanguage(script) === "ts" ? "component.td.ts" : "component.td.js",
    source,
    ts.ScriptTarget.ES2022,
    true,
    sfcScriptLanguage(script) === "ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );

const compilerErrorFromDiagnostic = (diagnostic: Diagnostic, script: TachyonSfcScript): CompilerError => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return {
    message,
    offset: script.offset + (typeof diagnostic.start === "number" ? diagnostic.start : 0),
  };
};

const transpileScriptContent = (script: TachyonSfcScript): Result<string, CompilerError> => {
  const language = sfcScriptLanguage(script);
  if (language === "js") {
    const diagnostic = jsSyntaxDiagnostic(script.content);
    return diagnostic
      ? err({ message: diagnostic.message, offset: script.offset + diagnostic.start })
      : ok(script.content.trim());
  }
  const result = ts.transpileModule(script.content, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
      verbatimModuleSyntax: true,
    },
    fileName: language === "ts" ? "component.td.ts" : "component.td.js",
    reportDiagnostics: true,
  });
  const diagnostic = result.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostic) {
    return err(compilerErrorFromDiagnostic(diagnostic, script));
  }
  return ok(result.outputText.trim());
};

const addBindingNames = (name: BindingName, names: Set<string>): void => {
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
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) names.add(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
        else
          for (const specifier of clause.namedBindings.elements) {
            if (!specifier.isTypeOnly) names.add(specifier.name.text);
          }
      }
    } else if (ts.isVariableStatement(statement)) {
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

const isDeclarationName = (node: Identifier): boolean => {
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
  const visit = (node: Node): void => {
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

const isFunctionBoundary = (node: Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node);

const topLevelAwaitNode = (sourceFile: SourceFile): Node | undefined => {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found) return;
    if (ts.isAwaitExpression(node)) {
      found = node;
      return;
    }
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      found = node.awaitModifier;
      return;
    }
    if (isFunctionBoundary(node)) return;
    ts.forEachChild(node, visit);
  };
  sourceFile.statements.forEach(visit);
  return found;
};

const setupFactoryCode = (
  content: string,
  script: TachyonSfcScript,
  setupBindings: readonly string[],
): Result<string, CompilerError> => {
  const sourceFile = sourceFileFor(content, script);
  const topLevelAwait = topLevelAwaitNode(sourceFile);
  if (topLevelAwait) {
    return err({
      message: "<script setup> does not support top-level await; move it into an async function.",
      offset: script.offset + topLevelAwait.getStart(sourceFile),
    });
  }
  const imports: string[] = [];
  const body: string[] = [];
  for (const statement of sourceFile.statements) {
    const statementText = content.slice(statement.getStart(sourceFile), statement.end).trim();
    if (ts.isImportDeclaration(statement)) {
      imports.push(statementText);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    ) {
      return err({
        message: "<script setup> cannot contain exports; expose values through top-level declarations.",
        offset: script.offset + statement.getStart(sourceFile),
      });
    }
    body.push(statementText);
  }
  const scopeEntries = setupBindings.map((name) => `${name}: ${name}`).join(", ");
  const indentedBody = body.flatMap((statement) => statement.split("\n").map((line) => `  ${line}`));
  return ok(
    `${imports.length > 0 ? `${imports.join("\n")}\n` : ""}const ${sfcSetupScopeName} = (inputScope = {}) => {\n${indentedBody.join("\n")}\n  return { ${scopeEntries} };\n};\n`,
  );
};

export const parseTachyonSfc = (source: string): Result<TachyonSfcDescriptor, CompilerError> => {
  const open = leadingScriptOpen(source);
  if (!open || !isComponentScript(open.attrs)) {
    return ok({
      template: source,
      mapTemplateOffset: (offset) => offset,
    });
  }
  const closePattern = /<\/script\s*>/gi;
  closePattern.lastIndex = open.end;
  const close = closePattern.exec(source);
  if (!close) {
    return err({ message: "Missing closing </script> tag.", offset: open.start });
  }
  const closeStart = close.index;
  const closeEnd = close.index + close[0].length;
  const before = "";
  const after = source.slice(closeEnd);
  const ranges: TemplateRange[] = [{ generatedStart: before.length, originalStart: closeEnd, length: after.length }];
  return ok({
    script: {
      attrs: open.attrs,
      content: source.slice(open.end, closeStart),
      offset: open.end,
    },
    template: `${before}${after}`,
    mapTemplateOffset: (offset) => mapGeneratedOffset(ranges, source.length, offset),
  });
};

export const compileTachyonSfc = (
  source: string,
  options: CompileTemplateOptions = {},
): Result<CompiledTachyonSfc, CompilerError> => {
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
  const template = compileTemplate(descriptor.value.template, options);
  if (!template.ok) {
    return err({
      message: template.error.message,
      offset: descriptor.value.mapTemplateOffset(template.error.offset),
      ...(template.error.endOffset === undefined
        ? {}
        : { endOffset: descriptor.value.mapTemplateOffset(template.error.endOffset) }),
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
    `export const hydrationDynamicAttributes = [];`,
    `export const hydrationDynamicRegions = [];`,
    `export const componentBoundaries = [];`,
    `export const bind = () => undefined;`,
  ].join("\n");
};

export const transformSfcScript = (
  script: TachyonSfcScript | undefined,
  options: TransformSfcScriptOptions = {},
): Result<TransformedSfcScript, CompilerError> => {
  if (!script || script.content.trim().length === 0) {
    return ok({ code: "", setupBindings: [], exposedBindings: [] });
  }
  const transpiled = transpileScriptContent(script);
  if (!transpiled.ok) {
    return err(transpiled.error);
  }
  const setupBindings = isSfcSetupScript(script) ? topLevelBindings(script) : [];
  const { templateIdentifiers } = options;
  const exposedBindings = templateIdentifiers
    ? setupBindings.filter((name) => templateIdentifiers.has(name))
    : setupBindings;
  const content = autoImportScriptHelpers(transpiled.value, script);
  if (isSfcSetupScript(script)) {
    const factory = setupFactoryCode(content, script, exposedBindings);
    if (!factory.ok) return factory;
    return ok({
      code: factory.value,
      defaultScopeName: sfcSetupScopeName,
      setupBindings,
      exposedBindings,
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
      exposedBindings,
    });
  }
  if (!defaultExport.test(content)) {
    return ok({ code: `${content.trim()}\n`, setupBindings, exposedBindings });
  }
  const code = content.replace(defaultExport, `const ${sfcDefaultScopeName} =`).trim();
  return ok({
    code: `${code}\nexport { ${sfcDefaultScopeName} as default };\n`,
    defaultScopeName: sfcDefaultScopeName,
    setupBindings,
    exposedBindings,
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
