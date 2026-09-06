import type { BindingName, DiagnosticCategory, Node, SourceFile } from "typescript";
import { compileTachyonSfc, isSfcSetupScript, sfcScriptLanguage } from "./compiler/sfc.js";
import { isAssignableExpression, parseExpression } from "./compiler/expression.js";
import {
  attrString,
  expressionToScopeAccess,
  itemNameFromKey,
  readExpressionAttribute,
  textExpressionSegments,
} from "./compiler/utils.js";
import type { ElementNode, TemplateNode } from "./compiler/types.js";
import { locateOffset } from "./diagnostics.js";
import { requireOptionalPeer } from "./optional-peer.js";
import { err, ok, type Result } from "./result.js";

type TypeScriptModule = typeof import("typescript");

let loadedTypeScript: TypeScriptModule | undefined;

const typescript = (): TypeScriptModule => {
  loadedTypeScript ??= requireOptionalPeer<TypeScriptModule>("typescript", "Tachyon template type checking");
  return loadedTypeScript;
};

export type TemplateTypeDiagnostic = {
  code: number;
  category: "error" | "warning" | "suggestion" | "message";
  message: string;
  offset: number;
  endOffset: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  sourceLine: string;
  source: "typescript";
};

export type TemplateTypeCheckOptions = {
  fileName?: string;
  /** An explicit TypeScript scope type used when the SFC has no typed scope export. */
  scopeType?: string;
};

type SourceMapping = {
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
};

type ScriptMapping = {
  virtualStart: number;
  virtualEnd: number;
  replacementStart?: number;
  replacementLength?: number;
  originalReplacementLength?: number;
};

type TypeCheckBuilder = {
  source: string;
  append: (text: string, mapping?: SourceMapping) => void;
  line: (text?: string, mapping?: SourceMapping) => void;
  offset: () => number;
  mappings: SourceMapping[];
};

type ExpressionLocation = {
  expression: string;
  start: number;
  end: number;
};

type ExpressionKind = "value" | "event" | "model";

const safeSourceOffset = (source: string, offset: number): number => Math.max(0, Math.min(source.length, offset));

const sourceOffsetForExpression = (
  descriptor: { mapTemplateOffset: (offset: number) => number },
  location: ExpressionLocation,
): ExpressionLocation => ({
  expression: location.expression,
  start: descriptor.mapTemplateOffset(location.start),
  end: descriptor.mapTemplateOffset(location.end),
});

const expressionLocationForAttribute = (attribute: {
  value: string | true;
  valueStart?: number;
}): ExpressionLocation | undefined => {
  if (attribute.value === true || attribute.valueStart === undefined) return undefined;
  const raw = attribute.value;
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open < 0 || close <= open) return undefined;
  const inner = raw.slice(open + 1, close);
  const leading = inner.search(/\S/);
  if (leading < 0) return undefined;
  const expression = inner.trim();
  const start = attribute.valueStart + open + 1 + leading;
  return { expression, start, end: start + expression.length };
};

const expressionLocationForText = (
  node: { value: string; start?: number },
  segment: { value: string; start: number; end: number },
): ExpressionLocation | undefined => {
  if (node.start === undefined) return undefined;
  const raw = node.value.slice(segment.start + 1, segment.end - 1);
  const leading = raw.search(/\S/);
  if (leading < 0) return undefined;
  const expression = raw.trim();
  const start = node.start + segment.start + 1 + leading;
  return { expression, start, end: start + expression.length };
};

const hasExportModifier = (ts: TypeScriptModule, node: Node): boolean =>
  ts.canHaveModifiers(node) &&
  Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));

const addBindingName = (ts: TypeScriptModule, name: BindingName, names: Set<string>): void => {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addBindingName(ts, element.name, names);
  }
};

const setupBindingNames = (ts: TypeScriptModule, sourceFile: SourceFile): string[] => {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) names.add(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.add(clause.namedBindings.name.text);
        } else {
          for (const element of clause.namedBindings.elements) names.add(element.name.text);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingName(ts, declaration.name, names);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  return [...names].filter((name) => name !== "__tachyonScope").sort();
};

const scopeExportKind = (ts: TypeScriptModule, sourceFile: SourceFile): { named: boolean; defaultStatement?: Node } => {
  let named = false;
  let defaultStatement: Node | undefined;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      defaultStatement = statement;
      continue;
    }
    if (!hasExportModifier(ts, statement)) continue;
    if (!ts.isVariableStatement(statement)) continue;
    if (
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "scope",
      )
    ) {
      named = true;
    }
  }
  return { named, ...(defaultStatement ? { defaultStatement } : {}) };
};

const createBuilder = (): TypeCheckBuilder => {
  let source = "";
  const mappings: SourceMapping[] = [];
  const append = (text: string, mapping?: SourceMapping): void => {
    const start = source.length;
    source += text;
    if (mapping) mappings.push({ ...mapping, start, end: source.length });
  };
  return {
    get source() {
      return source;
    },
    append,
    line: (text = "", mapping) => append(`${text}\n`, mapping),
    offset: () => source.length,
    mappings,
  };
};

const mappedLocation = (
  location: ExpressionLocation,
  descriptor: { mapTemplateOffset: (offset: number) => number },
): SourceMapping => {
  const mapped = sourceOffsetForExpression(descriptor, location);
  return { start: 0, end: 0, sourceStart: mapped.start, sourceEnd: mapped.end };
};

const expressionCode = (expression: string, locals: ReadonlySet<string>): string => {
  const parsed = parseExpression(expression);
  if (!parsed.ok) return "undefined";
  // Keep the checker aligned with the compiler's source-to-scope lowering. The
  // generated expression is only type checked and is never evaluated.
  return `(${expressionToScopeAccess(expression, locals, "__tachyonScope")})`;
};

const appendMappedExpression = (
  builder: TypeCheckBuilder,
  descriptor: { mapTemplateOffset: (offset: number) => number },
  location: ExpressionLocation,
  locals: ReadonlySet<string>,
  kind: ExpressionKind,
  index: number,
  eventName?: string,
): void => {
  const mapping = mappedLocation(location, descriptor);
  const access = expressionCode(location.expression, locals);
  if (kind === "event") {
    builder.line(
      `const __tachyonEventHandler${index}: __TachyonEventHandler<${JSON.stringify(eventName ?? "")}> = ${access};`,
      mapping,
    );
    return;
  }
  if (kind === "model") {
    // The third argument mirrors the runtime write-back contract: writable
    // signals are written through `.set`, readonly accessors are rejected, and
    // plain scope properties are assigned.
    builder.line(`__tachyonCheckModel(() => ${access}, (value) => { ${access} = value; }, ${access});`, mapping);
    return;
  }
  builder.line(`void ${access};`, mapping);
};

const appendAttributeExpressions = (
  builder: TypeCheckBuilder,
  descriptor: { mapTemplateOffset: (offset: number) => number },
  node: ElementNode,
  locals: ReadonlySet<string>,
  nextIndex: () => number,
): void => {
  for (const attribute of node.attrs) {
    const location = expressionLocationForAttribute(attribute);
    const expression = readExpressionAttribute(attribute.value);
    if (!location || !expression) continue;
    const kind: ExpressionKind = attribute.name.startsWith("on:")
      ? "event"
      : attribute.name.startsWith("bind:") && isAssignableExpression(expression)
        ? "model"
        : "value";
    appendMappedExpression(
      builder,
      descriptor,
      { ...location, expression },
      locals,
      kind,
      nextIndex(),
      kind === "event" ? attribute.name.slice(3) : undefined,
    );
  }
};

const appendTextExpressions = (
  builder: TypeCheckBuilder,
  descriptor: { mapTemplateOffset: (offset: number) => number },
  node: Extract<TemplateNode, { type: "text" }>,
  locals: ReadonlySet<string>,
  nextIndex: () => number,
): void => {
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind !== "expression") continue;
    const location = expressionLocationForText(node, segment);
    if (!location) continue;
    appendMappedExpression(builder, descriptor, location, locals, "value", nextIndex());
  }
};

const appendTemplateChecks = (
  builder: TypeCheckBuilder,
  descriptor: { mapTemplateOffset: (offset: number) => number },
  node: TemplateNode,
  locals: ReadonlySet<string>,
  nextIndex: () => number,
  blockIndex: { value: number },
): void => {
  if (node.type === "text") {
    appendTextExpressions(builder, descriptor, node, locals, nextIndex);
    return;
  }

  if (node.tagName === "for") {
    const eachAttribute = node.attrs.find((attribute) => attribute.name === "each");
    const keyAttribute = node.attrs.find((attribute) => attribute.name === "key");
    const eachLocation = eachAttribute && expressionLocationForAttribute(eachAttribute);
    const eachExpression = eachAttribute && readExpressionAttribute(eachAttribute.value);
    const keyLocation = keyAttribute && expressionLocationForAttribute(keyAttribute);
    const keyExpression = keyAttribute && readExpressionAttribute(keyAttribute.value);
    if (eachLocation && eachExpression) {
      const eachIndex = blockIndex.value++;
      appendMappedExpression(
        builder,
        descriptor,
        { ...eachLocation, expression: eachExpression },
        locals,
        "value",
        nextIndex(),
      );
      const eachAccess = expressionCode(eachExpression, locals);
      builder.line(`{`);
      builder.line(`const __tachyonEach${eachIndex} = ${eachAccess};`);
      const itemName = attrString(node, "as")?.trim() || itemNameFromKey(keyExpression ?? "item");
      const indexName = attrString(node, "index")?.trim();
      builder.line(`const ${itemName} = null as unknown as __TachyonListItem<typeof __tachyonEach${eachIndex}>;`);
      if (indexName) builder.line(`const ${indexName} = 0;`);
      const childLocals = new Set(locals);
      childLocals.add(itemName);
      if (indexName) childLocals.add(indexName);
      if (keyLocation && keyExpression) {
        appendMappedExpression(
          builder,
          descriptor,
          { ...keyLocation, expression: keyExpression },
          childLocals,
          "value",
          nextIndex(),
        );
      }
      for (const child of node.children) {
        appendTemplateChecks(builder, descriptor, child, childLocals, nextIndex, blockIndex);
      }
      builder.line(`}`);
      return;
    }
  }

  appendAttributeExpressions(builder, descriptor, node, locals, nextIndex);
  if (node.tagName === "await") {
    const valueAttribute = node.attrs.find((attribute) => attribute.name === "value");
    const valueLocation = valueAttribute && expressionLocationForAttribute(valueAttribute);
    const valueExpression = valueAttribute && readExpressionAttribute(valueAttribute.value);
    if (valueLocation && valueExpression) {
      const valueIndex = blockIndex.value++;
      builder.line(`{`);
      appendMappedExpression(
        builder,
        descriptor,
        { ...valueLocation, expression: valueExpression },
        locals,
        "value",
        nextIndex(),
      );
      builder.line(`const __tachyonAwait${valueIndex} = ${expressionCode(valueExpression, locals)};`);
      const thenName = attrString(node, "then")?.trim();
      const childLocals = new Set(locals);
      if (thenName) {
        builder.line(`const ${thenName} = null as unknown as __TachyonAwaitValue<typeof __tachyonAwait${valueIndex}>;`);
        childLocals.add(thenName);
      }
      for (const child of node.children) {
        appendTemplateChecks(builder, descriptor, child, childLocals, nextIndex, blockIndex);
      }
      builder.line(`}`);
      return;
    }
  }
  if (node.tagName === "if") {
    const testAttribute = node.attrs.find((attribute) => attribute.name === "test");
    const testLocation = testAttribute && expressionLocationForAttribute(testAttribute);
    const testExpression = testAttribute && readExpressionAttribute(testAttribute.value);
    if (testLocation && testExpression) {
      appendMappedExpression(
        builder,
        descriptor,
        { ...testLocation, expression: testExpression },
        locals,
        "value",
        nextIndex(),
      );
    }
  }
  for (const child of node.children) {
    appendTemplateChecks(builder, descriptor, child, locals, nextIndex, blockIndex);
  }
};

const categoryFor = (ts: TypeScriptModule, category: DiagnosticCategory): TemplateTypeDiagnostic["category"] => {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  if (category === ts.DiagnosticCategory.Suggestion) return "suggestion";
  return "message";
};

const scriptOffsetForDiagnostic = (mapping: ScriptMapping, virtualOffset: number): number => {
  const relative = Math.max(0, virtualOffset - mapping.virtualStart);
  if (
    mapping.replacementStart === undefined ||
    mapping.replacementLength === undefined ||
    mapping.originalReplacementLength === undefined
  ) {
    return relative;
  }
  if (relative <= mapping.replacementStart) return relative;
  const replacementEnd = mapping.replacementStart + mapping.replacementLength;
  if (relative <= replacementEnd) return mapping.replacementStart;
  return mapping.replacementStart + mapping.originalReplacementLength + (relative - replacementEnd);
};

const diagnosticFromTypeScript = (
  ts: TypeScriptModule,
  source: string,
  diagnostic: import("typescript").Diagnostic,
  mappings: readonly SourceMapping[],
  scriptMapping: ScriptMapping | undefined,
  script: { offset: number } | undefined,
): TemplateTypeDiagnostic | undefined => {
  if (!diagnostic.file || typeof diagnostic.start !== "number") return undefined;
  const virtualStart = diagnostic.start;
  const virtualEnd = virtualStart + (diagnostic.length ?? 1);
  let offset: number | undefined;
  let endOffset: number | undefined;
  if (scriptMapping && virtualStart >= scriptMapping.virtualStart && virtualStart <= scriptMapping.virtualEnd) {
    const start = scriptOffsetForDiagnostic(scriptMapping, virtualStart);
    const end = scriptOffsetForDiagnostic(scriptMapping, Math.min(scriptMapping.virtualEnd, virtualEnd));
    offset = (script?.offset ?? 0) + start;
    endOffset = (script?.offset ?? 0) + Math.max(start + 1, end);
  } else {
    const mapping = mappings.find((candidate) => virtualStart >= candidate.start && virtualStart <= candidate.end);
    if (!mapping) return undefined;
    offset = mapping.sourceStart;
    endOffset = Math.max(mapping.sourceStart + 1, mapping.sourceEnd);
  }
  offset = safeSourceOffset(source, offset);
  endOffset = safeSourceOffset(source, Math.max(offset + 1, endOffset));
  const start = locateOffset(source, offset);
  const end = locateOffset(source, endOffset);
  return {
    code: diagnostic.code,
    category: categoryFor(ts, diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    offset,
    endOffset,
    ...start,
    endLine: end.line,
    endColumn: end.column,
    source: "typescript",
  };
};

const createCompilerHost = (
  ts: TypeScriptModule,
  fileName: string,
  virtualSource: string,
): import("typescript").CompilerHost => {
  const options: import("typescript").CompilerOptions = {
    allowJs: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(fileName, virtualSource, languageVersion, true, ts.ScriptKind.TS)
      : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.readFile = (name) => (name === fileName ? virtualSource : originalReadFile(name));
  host.fileExists = (name) => name === fileName || originalFileExists(name);
  return host;
};

export const checkTachyonTemplateTypes = (
  source: string,
  options: TemplateTypeCheckOptions = {},
): Result<readonly TemplateTypeDiagnostic[], string> => {
  const parsed = compileTachyonSfc(source);
  if (!parsed.ok) return err(parsed.error.message);
  const ts = typescript();
  const script = parsed.value.descriptor.script;
  const requestedFileName = options.fileName ?? "component.td.ts";
  const fileName = /\.(?:[cm]?tsx?|jsx?)$/i.test(requestedFileName) ? requestedFileName : `${requestedFileName}.ts`;
  const scriptSourceFile = script
    ? ts.createSourceFile(
        fileName,
        script.content,
        ts.ScriptTarget.ES2022,
        true,
        sfcScriptLanguage(script) === "ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS,
      )
    : undefined;
  const scopeKind = scriptSourceFile ? scopeExportKind(ts, scriptSourceFile) : { named: false };
  const hasScope =
    Boolean(options.scopeType) || isSfcSetupScript(script) || scopeKind.named || scopeKind.defaultStatement;
  if (!hasScope) return ok([]);

  const builder = createBuilder();
  let scriptMapping: ScriptMapping | undefined;
  if (script) {
    const defaultKeyword = scopeKind.defaultStatement ? /\bexport\s+default\b/.exec(script.content) : undefined;
    const replacement = "const __tachyonDefaultScope =";
    const scriptContent =
      defaultKeyword && defaultKeyword.index !== undefined
        ? `${script.content.slice(0, defaultKeyword.index)}${replacement}${script.content.slice(defaultKeyword.index + defaultKeyword[0].length)}`
        : script.content;
    const virtualStart = builder.offset();
    builder.append(scriptContent);
    builder.line();
    scriptMapping = {
      virtualStart,
      virtualEnd: virtualStart + scriptContent.length,
      ...(defaultKeyword && defaultKeyword.index !== undefined
        ? {
            replacementStart: defaultKeyword.index,
            replacementLength: replacement.length,
            originalReplacementLength: defaultKeyword[0].length,
          }
        : {}),
    };
  }

  if (options.scopeType) {
    builder.line(`type __TachyonScope = ${options.scopeType};`);
    builder.line(`declare const __tachyonScope: __TachyonScope;`);
  } else if (isSfcSetupScript(script) && scriptSourceFile) {
    const names = setupBindingNames(ts, scriptSourceFile);
    builder.line(`const __tachyonScope = { ${names.join(", ")} };`);
    builder.line(`type __TachyonScope = typeof __tachyonScope;`);
  } else if (scopeKind.named) {
    builder.line(
      `type __TachyonScope = typeof scope extends (...args: any[]) => infer TValue ? TValue : typeof scope;`,
    );
    builder.line(`declare const __tachyonScope: __TachyonScope;`);
  } else {
    builder.line(
      `type __TachyonScope = typeof __tachyonDefaultScope extends (...args: any[]) => infer TValue ? TValue : typeof __tachyonDefaultScope;`,
    );
    builder.line(`declare const __tachyonScope: __TachyonScope;`);
  }
  builder.line(`type __TachyonListValue<T> = T extends (...args: any[]) => infer TValue ? TValue : T;`);
  builder.line(
    `type __TachyonListItem<T> = NonNullable<__TachyonListValue<T>> extends readonly (infer TValue)[] ? TValue : never;`,
  );
  builder.line(`type __TachyonAwaitValue<T> = T extends PromiseLike<infer TValue> ? TValue : T;`);
  builder.line(
    `type __TachyonEventOf<Name extends string> = Name extends keyof HTMLElementEventMap ? HTMLElementEventMap[Name] : Event;`,
  );
  // Unknown event names keep a bivariant method contract so CustomEvent
  // handlers are accepted; known DOM events use the precise event type.
  builder.line(
    `type __TachyonEventHandler<Name extends string> = Name extends keyof HTMLElementEventMap ? (event: __TachyonEventOf<Name>) => unknown : { handler(event: Event): unknown }["handler"];`,
  );
  builder.line(
    `type __TachyonReadonlyModelTarget = { readonly __tachyonModelError: "bind: requires a writable signal or a plain scope property; a readonly signal accessor cannot be written" };`,
  );
  builder.line(
    `type __TachyonModelTarget<T> = [T] extends [(...args: any[]) => unknown] ? ([T] extends [{ set: (value: any) => void }] ? T : __TachyonReadonlyModelTarget) : T;`,
  );
  builder.line(
    `const __tachyonCheckModel = <T>(_read: () => T, _write: (value: T) => void, _target: __TachyonModelTarget<T>): void => undefined;`,
  );
  builder.line(`const __tachyonCheckTemplate = (__tachyonScope: __TachyonScope): void => {`);
  let expressionIndex = 0;
  const nextIndex = (): number => expressionIndex++;
  appendTemplateChecks(builder, parsed.value.descriptor, parsed.value.template.root, new Set(), nextIndex, {
    value: 0,
  });
  builder.line(`};`);

  const compilerOptions: import("typescript").CompilerOptions = {
    allowJs: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const program = ts.createProgram([fileName], compilerOptions, createCompilerHost(ts, fileName, builder.source));
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === fileName)
    .map((diagnostic) => diagnosticFromTypeScript(ts, source, diagnostic, builder.mappings, scriptMapping, script))
    .filter((diagnostic): diagnostic is TemplateTypeDiagnostic => diagnostic !== undefined);
  const unique = new Map<string, TemplateTypeDiagnostic>();
  for (const diagnostic of diagnostics) {
    unique.set(`${diagnostic.code}:${diagnostic.offset}:${diagnostic.message}`, diagnostic);
  }
  return ok([...unique.values()].sort((left, right) => left.offset - right.offset || left.code - right.code));
};

export const diagnoseTachyonTemplateTypes = checkTachyonTemplateTypes;
export const checkTachyonSfcTypes = checkTachyonTemplateTypes;

export const formatTemplateTypeDiagnostic = (diagnostic: TemplateTypeDiagnostic, file = "<template>"): string => {
  const pointer = `${" ".repeat(Math.max(0, diagnostic.column - 1))}^`;
  return `${file}:${diagnostic.line}:${diagnostic.column}: TS${diagnostic.code}: ${diagnostic.message}\n${diagnostic.sourceLine}\n${pointer}`;
};
