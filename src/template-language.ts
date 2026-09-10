import { parseTachyonSfc } from "./compiler/sfc.js";
import { itemNameFromKey } from "./compiler/utils.js";

export type TemplateLanguagePosition = {
  line: number;
  character: number;
};

export type TemplateLanguageRange = {
  start: TemplateLanguagePosition;
  end: TemplateLanguagePosition;
};

export type TemplateCompletionItem = {
  label: string;
  kind: "variable" | "property" | "directive";
  detail?: string;
};

export type TemplateHover = {
  contents: { kind: "markdown"; value: string };
  range: TemplateLanguageRange;
};

export type TemplateDefinition = {
  uri?: string;
  range: TemplateLanguageRange;
};

export type TemplateTextEdit = {
  range: TemplateLanguageRange;
  newText: string;
};

export type TemplateRename = {
  edits: readonly TemplateTextEdit[];
};

export type TemplateLanguageFeatures = {
  capabilities: {
    completion: true;
    hover: true;
    definition: true;
    rename: true;
  };
  completion: (position: TemplateLanguagePosition) => TemplateCompletionItem[];
  hover: (position: TemplateLanguagePosition) => TemplateHover | undefined;
  definition: (position: TemplateLanguagePosition) => TemplateDefinition | undefined;
  rename: (position: TemplateLanguagePosition, newName: string) => TemplateRename | undefined;
};

type SymbolInfo = {
  name: string;
  start: number;
  end: number;
  kind: "script" | "template";
  detail: string;
};

type Word = {
  name: string;
  start: number;
  end: number;
};

type LexToken = {
  name?: string;
  punct?: string;
  start: number;
  end: number;
};

type BindingScope = {
  start: number;
  end: number;
  parent?: BindingScope;
  bindings: Map<string, Binding>;
};

type Binding = SymbolInfo & {
  scope: BindingScope;
};

type Reference = Word & {
  binding: Binding;
};

type CollectedSymbols = {
  symbols: Map<string, SymbolInfo>;
  references: Reference[];
  /** True when the script contains syntax whose scope cannot be resolved safely. */
  unsafeRename: boolean;
};

const reservedWords = new Set([
  "as",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
const declarationWords = new Set(["const", "let", "var", "function", "class", "interface", "type", "enum"]);
const directiveItems: TemplateCompletionItem[] = [
  { label: "if", kind: "directive", detail: "Conditional template block" },
  { label: "for", kind: "directive", detail: "Keyed list template block" },
  { label: "await", kind: "directive", detail: "Async template block" },
  { label: "component", kind: "directive", detail: "Transparent component boundary" },
  { label: "store", kind: "directive", detail: "Local reactive store" },
  { label: "hydrate", kind: "directive", detail: "Hydration boundary" },
  { label: "bind", kind: "directive", detail: "Two-way control binding" },
];

const identifierStart = (value: string | undefined): boolean => value !== undefined && /[A-Za-z_$]/.test(value);
const identifierPart = (value: string | undefined): boolean => value !== undefined && /[A-Za-z0-9_$]/.test(value);

const tokenise = (source: string, offset = 0): LexToken[] => {
  const tokens: LexToken[] = [];
  const previousPunct = (): string | undefined => tokens.at(-1)?.punct;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = source[index + 1] as string | undefined;
    if (/\s/.test(char)) continue;
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end - 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === quote) break;
      }
      continue;
    }
    if (
      char === "/" &&
      previousPunct() !== "." &&
      [undefined, "=", "(", "[", "{", ",", ":", ";", "!", "?", "return", "=>"].includes(previousPunct())
    ) {
      let escaped = false;
      for (index += 1; index < source.length; index += 1) {
        const value = source[index] as string;
        if (!escaped && value === "/") break;
        escaped = !escaped && value === "\\";
        if (value !== "\\") escaped = false;
      }
      while (identifierPart(source[index + 1])) index += 1;
      continue;
    }
    if (identifierStart(char)) {
      let end = index + 1;
      while (identifierPart(source[end])) end += 1;
      tokens.push({ name: source.slice(index, end), start: offset + index, end: offset + end });
      index = end - 1;
      continue;
    }
    const punct = source.startsWith("?.", index) ? "?." : char;
    tokens.push({ punct, start: offset + index, end: offset + index + punct.length });
    if (punct.length > 1) index += punct.length - 1;
  }
  return tokens;
};

const positionToOffset = (source: string, position: TemplateLanguagePosition): number => {
  let offset = 0;
  let line = 0;
  while (line < position.line && offset < source.length) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return source.length;
    offset = newline + 1;
    line += 1;
  }
  return Math.min(source.length, offset + Math.max(0, position.character));
};

const offsetToPosition = (source: string, offset: number): TemplateLanguagePosition => {
  const before = source.slice(0, Math.max(0, Math.min(source.length, offset)));
  const lines = before.split(/\r?\n/);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
};

const rangeFor = (source: string, start: number, end: number): TemplateLanguageRange => ({
  start: offsetToPosition(source, start),
  end: offsetToPosition(source, end),
});

const addSymbol = (symbols: Map<string, SymbolInfo>, symbol: SymbolInfo): void => {
  const existing = symbols.get(symbol.name);
  if (!existing || (existing.kind === "template" && symbol.kind === "script")) symbols.set(symbol.name, symbol);
};

const scopeFor = (scopes: readonly BindingScope[], offset: number): BindingScope =>
  scopes
    .filter((scope) => scope.start <= offset && offset < scope.end)
    .sort((left, right) => right.start - left.start)[0] ?? scopes[0]!;

const resolveBinding = (scope: BindingScope, name: string): Binding | undefined => {
  let current: BindingScope | undefined = scope;
  while (current) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
    current = current.parent;
  }
  return undefined;
};

const expressionWords = (expression: string, offset: number): Word[] => {
  const tokens = tokenise(expression, offset);
  const words: Word[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token?.name || reservedWords.has(token.name)) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (previous?.punct === "." || previous?.punct === "?." || next?.punct === ":") continue;
    words.push({ name: token.name, start: token.start, end: token.end });
  }
  return words;
};

const expressionRanges = (source: string, start: number): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = start; index < source.length; index += 1) {
    if (source[index] !== "{") continue;
    let depth = 1;
    let quote: string | undefined;
    let end = index + 1;
    for (; end < source.length && depth > 0; end += 1) {
      const char = source[end] as string;
      if (quote) {
        if (char === "\\") end += 1;
        else if (char === quote) quote = undefined;
      } else if (char === "'" || char === '"' || char === "`") {
        quote = char;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (depth === 0) {
      ranges.push({ start: index + 1, end: end - 1 });
      index = end - 1;
    }
  }
  return ranges;
};

const templateOffsetFor = (source: string, scriptOffset: number, scriptLength: number): number => {
  const closeStart = source.indexOf("</script", scriptOffset + scriptLength);
  if (closeStart < 0) return scriptOffset + scriptLength;
  const closeEnd = source.indexOf(">", closeStart);
  return closeEnd < 0 ? source.length : closeEnd + 1;
};

const quotedBinding = (attrs: string, attrsOffset: number, name: string): Word | undefined => {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])([A-Za-z_$][A-Za-z0-9_$]*)\\1`, "i");
  const match = pattern.exec(attrs);
  if (!match) return undefined;
  const value = match[2] as string;
  const valueStart = (match.index ?? 0) + match[0].indexOf(value);
  return { name: value, start: attrsOffset + valueStart, end: attrsOffset + valueStart + value.length };
};

const scriptSymbols = (
  scriptOffset: number,
  script: string,
  symbols: Map<string, SymbolInfo>,
  references: Reference[],
): { root: BindingScope; unsafeRename: boolean } => {
  const root: BindingScope = { start: scriptOffset, end: scriptOffset + script.length, bindings: new Map() };
  let unsafeRename = false;
  const tokens = tokenise(script, scriptOffset);
  const scopes: BindingScope[] = [root];
  const stack: BindingScope[] = [root];
  for (const token of tokens) {
    if (token.punct === "{") {
      const parent = stack.at(-1);
      const child: BindingScope = {
        start: token.end,
        end: root.end,
        ...(parent ? { parent } : {}),
        bindings: new Map(),
      };
      scopes.push(child);
      stack.push(child);
    } else if (token.punct === "}" && stack.length > 1) {
      const child = stack.pop()!;
      child.end = token.start;
    }
  }
  const scopeAt = (offset: number): BindingScope => scopeFor(scopes, offset);
  const declare = (token: LexToken, detail: string, target = scopeAt(token.start)): Binding => {
    const name = token.name!;
    const existing = target.bindings.get(name);
    if (existing) return existing;
    const binding: Binding = { name, start: token.start, end: token.end, kind: "script", detail, scope: target };
    target.bindings.set(name, binding);
    addSymbol(symbols, binding);
    return binding;
  };
  const blockScopeStartingAt = (offset: number): BindingScope | undefined =>
    scopes.find((scope) => scope !== root && scope.start === offset);
  const expressionEndFrom = (startIndex: number): number => {
    let depth = 0;
    for (let index = startIndex; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.punct === "(" || token.punct === "[" || token.punct === "{") depth += 1;
      else if (token.punct === ")" || token.punct === "]" || token.punct === "}") {
        if (depth === 0) return token.start;
        depth -= 1;
      } else if ((token.punct === ";" || token.punct === ",") && depth === 0) {
        return token.start;
      }
    }
    return root.end;
  };
  const closingParenIndex = (openIndex: number): number => {
    let depth = 0;
    for (let index = openIndex; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.punct === "(") depth += 1;
      else if (token.punct === ")") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  };
  const openingParenIndex = (closeIndex: number): number => {
    let depth = 0;
    for (let index = closeIndex; index >= 0; index -= 1) {
      const token = tokens[index]!;
      if (token.punct === ")") depth += 1;
      else if (token.punct === "(") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  };
  const isArrowAt = (index: number): boolean => tokens[index]?.punct === "=" && tokens[index + 1]?.punct === ">";
  // True when the arrow at `arrowIndex` (index of its `=`) sits inside a return
  // type annotation: its parameter list is preceded by `): `.
  const isReturnTypeArrow = (arrowIndex: number): boolean => {
    const previous = tokens[arrowIndex - 1];
    let before: number;
    if (previous?.punct === ")") {
      const openIndex = openingParenIndex(arrowIndex - 1);
      if (openIndex < 0) return false;
      before = openIndex - 1;
    } else if (previous?.name) {
      before = arrowIndex - 2;
    } else {
      return false;
    }
    return tokens[before]?.punct === ":" && tokens[before - 1]?.punct === ")";
  };
  const parameterListBeforeReturnType = (arrowIndex: number): number | "unsafe" | undefined => {
    let depth = 0;
    for (let index = arrowIndex - 1; index >= 0; index -= 1) {
      const token = tokens[index]!;
      if (token.punct === ")" || token.punct === "]" || token.punct === "}" || token.punct === ">") {
        if (token.punct === ">" && tokens[index - 1]?.punct === "=") {
          if (depth > 0) return "unsafe";
          // A preceding arrow at depth 0 is either a curried arrow (`a => b =>`)
          // or a function type inside a return annotation
          // (`(x): (y: T) => R => body`). Only the latter is ambiguous.
          return isReturnTypeArrow(index - 1) ? "unsafe" : undefined;
        }
        depth += 1;
        continue;
      }
      if (token.punct === "(" || token.punct === "[" || token.punct === "{" || token.punct === "<") {
        if (depth === 0) return undefined;
        depth -= 1;
        continue;
      }
      if (depth > 0) continue;
      if (token.punct === ":") {
        return tokens[index - 1]?.punct === ")" ? index - 1 : undefined;
      }
      if (token.punct === "," || token.punct === ";" || token.punct === "=" || token.punct === "?") return undefined;
      if (token.name && reservedWords.has(token.name)) return undefined;
    }
    return undefined;
  };
  const parameterTokens = (openIndex: number, closeIndex: number): LexToken[] => {
    const names: LexToken[] = [];
    let depth = 0;
    // While defined, tokens belong to a default value or a type annotation
    // that started at this depth. Those expressions reference outer bindings
    // and must never be registered as parameter names.
    let skipUntilDepth: number | undefined;
    for (let index = openIndex + 1; index < closeIndex; index += 1) {
      const token = tokens[index]!;
      const previous = tokens[index - 1];
      if (token.punct === "(" || token.punct === "[" || token.punct === "{") depth += 1;
      else if (token.punct === ")" || token.punct === "]" || token.punct === "}") depth -= 1;
      if (skipUntilDepth !== undefined) {
        if ((token.punct === "," && depth === skipUntilDepth) || depth < skipUntilDepth) skipUntilDepth = undefined;
        else continue;
      }
      if (token.punct === "=" || (depth === 0 && token.punct === ":")) {
        skipUntilDepth = depth;
        continue;
      }
      if (!token.name || reservedWords.has(token.name)) continue;
      const spread = previous?.punct === "." && tokens[index - 2]?.punct === "." && tokens[index - 3]?.punct === ".";
      if (depth === 0 && (previous?.punct === "(" || previous?.punct === "," || spread)) names.push(token);
      else if (depth > 0 && (previous?.punct !== "." || spread) && tokens[index + 1]?.punct !== ":") names.push(token);
    }
    return names;
  };
  const registerParameters = (parameters: readonly LexToken[], start: number, bodyIndex: number): void => {
    if (parameters.length === 0) return;
    let bodyStart = bodyIndex;
    while (bodyStart < tokens.length && !isArrowAt(bodyStart) && tokens[bodyStart]?.punct !== "{") {
      if (tokens[bodyStart]?.punct === ";") return;
      bodyStart += 1;
    }
    if (isArrowAt(bodyStart)) bodyStart += 2;
    const bodyToken = tokens[bodyStart];
    const block = bodyToken?.punct === "{" ? blockScopeStartingAt(bodyToken.end) : undefined;
    const end = block ? block.end : expressionEndFrom(bodyStart);
    const parent = scopeAt(start);
    const parameterScope: BindingScope = { start, end, parent, bindings: new Map() };
    // Reparent every block scope that lies inside the parameter scope so
    // references in expression bodies such as `({ value: title })` resolve
    // to the parameters first.
    for (const candidate of scopes) {
      if (candidate === parameterScope || candidate.parent !== parent) continue;
      if (candidate.start >= start && candidate.end <= end) candidate.parent = parameterScope;
    }
    scopes.push(parameterScope);
    for (const parameter of parameters) declare(parameter, "Function parameter", parameterScope);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.name === "function") {
      let openIndex = index + 1;
      if (tokens[openIndex]?.name) openIndex += 1;
      if (tokens[openIndex]?.punct !== "(") continue;
      const closeIndex = closingParenIndex(openIndex);
      if (closeIndex < 0) continue;
      registerParameters(parameterTokens(openIndex, closeIndex), tokens[openIndex]!.start, closeIndex + 1);
      continue;
    }
    // Method shorthand and class methods: `name(params) {`.
    if (
      token.name &&
      !reservedWords.has(token.name) &&
      tokens[index + 1]?.punct === "(" &&
      tokens[index - 1]?.name !== "function"
    ) {
      const closeIndex = closingParenIndex(index + 1);
      if (closeIndex >= 0 && tokens[closeIndex + 1]?.punct === "{") {
        registerParameters(parameterTokens(index + 1, closeIndex), tokens[index + 1]!.start, closeIndex + 1);
        continue;
      }
    }
    if (!isArrowAt(index)) continue;
    const previous = tokens[index - 1];
    if (previous?.punct === ")") {
      const openIndex = openingParenIndex(index - 1);
      if (openIndex < 0) continue;
      const parameters = parameterTokens(openIndex, index - 1);
      registerParameters(parameters, tokens[openIndex]!.start, index);
      continue;
    }
    // The arrow may carry a return type annotation: `(params): Type => body`.
    // Walk backwards over the annotation to the `:` that follows the closing
    // parenthesis of the parameter list.
    const closeIndex = parameterListBeforeReturnType(index);
    if (closeIndex === "unsafe") {
      unsafeRename = true;
      continue;
    }
    if (closeIndex !== undefined) {
      const openIndex = openingParenIndex(closeIndex);
      if (openIndex < 0) continue;
      registerParameters(parameterTokens(openIndex, closeIndex), tokens[openIndex]!.start, index);
      continue;
    }
    if (previous?.name && !reservedWords.has(previous.name)) {
      registerParameters([previous], previous.start, index);
    }
  }
  const braceDepthAt = (offset: number): number => {
    let depth = 0;
    for (const token of tokens) {
      if (token.start >= offset) break;
      if (token.punct === "{") depth += 1;
      else if (token.punct === "}") depth -= 1;
    }
    return depth;
  };
  let variable: { scope: BindingScope; brace: number; paren: number; bracket: number; expect: boolean } | undefined;
  let importMode = false;
  let importFirst = true;
  let importBrace = false;
  let paren = 0;
  let bracket = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = tokens[index - 1];
    if (token.punct === "(") paren += 1;
    if (token.punct === ")") paren = Math.max(0, paren - 1);
    if (token.punct === "[") bracket += 1;
    if (token.punct === "]") bracket = Math.max(0, bracket - 1);
    if (token.name === "import") {
      importMode = true;
      importFirst = true;
      importBrace = false;
      variable = undefined;
      continue;
    }
    if (importMode) {
      if (token.punct === ";") importMode = false;
      else if (token.punct === "{") importBrace = true;
      else if (token.punct === "}") importBrace = false;
      else if (token.name && token.name !== "type" && token.name !== "from") {
        if (previous?.name === "as" || importFirst || (importBrace && tokens[index + 1]?.name !== "as")) {
          declare(token, "Imported in the component script");
        }
        importFirst = false;
      }
      continue;
    }
    if (token.name && declarationWords.has(token.name)) {
      if (
        token.name === "function" ||
        token.name === "class" ||
        token.name === "interface" ||
        token.name === "type" ||
        token.name === "enum"
      ) {
        const next = tokens[index + 1];
        if (next?.name) declare(next, "Declared in the component script");
        variable = undefined;
      } else {
        variable = { scope: scopeAt(token.start), brace: braceDepthAt(token.start), paren, bracket, expect: true };
      }
      continue;
    }
    if (!variable) continue;
    const sameLevel =
      braceDepthAt(token.start) === variable.brace && paren === variable.paren && bracket === variable.bracket;
    if (token.name && variable.expect && sameLevel) {
      declare(token, "Declared in the component script", variable.scope);
      variable.expect = false;
    } else if (token.punct === "," && sameLevel) {
      variable.expect = true;
    } else if (token.punct === ";" || (token.name && declarationWords.has(token.name) && sameLevel)) {
      variable =
        token.name && declarationWords.has(token.name)
          ? { scope: scopeAt(token.start), brace: braceDepthAt(token.start), paren, bracket, expect: true }
          : undefined;
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.name || reservedWords.has(token.name)) continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (previous?.punct === "." || previous?.punct === "?." || next?.punct === ":") continue;
    const binding = resolveBinding(scopeAt(token.start), token.name);
    if (binding) references.push({ name: token.name, start: token.start, end: token.end, binding });
  }
  return { root, unsafeRename };
};

const collectSymbols = (source: string): CollectedSymbols => {
  const symbols = new Map<string, SymbolInfo>();
  const references: Reference[] = [];
  const descriptor = parseTachyonSfc(source);
  const script = descriptor.ok ? descriptor.value.script : undefined;
  const template = descriptor.ok ? descriptor.value.template : source;
  const templateOffset = script ? templateOffsetFor(source, script.offset, script.content.length) : 0;
  const collected = script ? scriptSymbols(script.offset, script.content, symbols, references) : undefined;
  const scriptRoot = collected?.root;
  const templateRoot: BindingScope = {
    start: templateOffset,
    end: source.length,
    ...(scriptRoot ? { parent: scriptRoot } : {}),
    bindings: new Map(),
  };
  const templateScopes: BindingScope[] = [templateRoot];
  const keyRanges: Array<{ start: number; end: number; scope: BindingScope }> = [];
  const blockStack: Array<{ tag: string; scope: BindingScope }> = [];
  const remember = (word: Word, binding: Binding): void => {
    references.push({ ...word, binding });
  };
  const declareTemplate = (word: Word, scope: BindingScope): Binding => {
    const existing = scope.bindings.get(word.name);
    if (existing) return existing;
    const binding: Binding = { ...word, kind: "template", detail: "Local template binding", scope };
    scope.bindings.set(word.name, binding);
    addSymbol(symbols, binding);
    return binding;
  };
  const tagPattern = /<\s*(\/?)\s*(for|await)\b([^>]*?)>/gi;
  for (const match of template.matchAll(tagPattern)) {
    const relative = match.index ?? 0;
    const absolute = templateOffset + relative;
    const tag = (match[2] as string).toLowerCase();
    if (match[1]) {
      const stackIndex = blockStack.map((entry) => entry.tag).lastIndexOf(tag);
      if (stackIndex >= 0) {
        const entry = blockStack.splice(stackIndex, 1)[0]!;
        entry.scope.end = absolute;
      }
      continue;
    }
    const rawAttrs = match[3] as string;
    if (/\/\s*$/.test(rawAttrs)) continue;
    const parent = blockStack.at(-1)?.scope ?? templateRoot;
    const tagStart = absolute;
    const tagEnd = absolute + (match[0]?.length ?? 0);
    const scope: BindingScope = { start: tagEnd, end: source.length, parent, bindings: new Map() };
    templateScopes.push(scope);
    blockStack.push({ tag, scope });
    const attrsOffset = tagStart + (match[0]?.indexOf(rawAttrs) ?? 0);
    for (const alias of tag === "for" ? ["as", "index"] : ["then"]) {
      const word = quotedBinding(rawAttrs, attrsOffset, alias);
      if (word) remember(word, declareTemplate(word, scope));
    }
    if (tag !== "for") continue;
    // The key expression is evaluated per row, so it resolves in the row scope
    // even though it sits inside the opening tag. The each expression stays in
    // the outer scope.
    // Both `key={expr}` and `key="{expr}"` are accepted by the compiler.
    const keyMatch = /\bkey\s*=\s*(?:["']\s*)?\{/i.exec(rawAttrs);
    if (!keyMatch) continue;
    const keyStart = attrsOffset + keyMatch.index + keyMatch[0].length;
    const keyRange = expressionRanges(source, keyStart - 1).find((range) => range.start === keyStart);
    if (!keyRange) continue;
    keyRanges.push({ ...keyRange, scope });
    if (!quotedBinding(rawAttrs, attrsOffset, "as")) {
      const keyExpression = source.slice(keyRange.start, keyRange.end);
      const implicitName = itemNameFromKey(keyExpression.trim());
      const implicitWord = expressionWords(keyExpression, keyRange.start).find((word) => word.name === implicitName);
      if (implicitWord) declareTemplate(implicitWord, scope);
    }
  }
  for (const entry of blockStack) entry.scope.end = source.length;
  const localTagPattern = /<\s*(component|store)\b([^>]*?)>/gi;
  for (const match of template.matchAll(localTagPattern)) {
    const absolute = templateOffset + (match.index ?? 0);
    const attrs = match[2] as string;
    const scope = scopeFor(templateScopes, absolute);
    const attrsOffset = absolute + (match[0]?.indexOf(attrs) ?? 0);
    const attrPattern = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:["']\s*)?\{/g;
    for (const attr of attrs.matchAll(attrPattern)) {
      const name = attr[1] as string;
      const start = attrsOffset + (attr.index ?? 0);
      const word = { name, start, end: start + name.length };
      remember(word, declareTemplate(word, scope));
    }
  }
  for (const range of expressionRanges(source, templateOffset)) {
    const keyRange = keyRanges.find((candidate) => candidate.start <= range.start && range.end <= candidate.end);
    const scope = keyRange ? keyRange.scope : scopeFor(templateScopes, range.start);
    for (const word of expressionWords(source.slice(range.start, range.end), range.start)) {
      const binding = resolveBinding(scope, word.name);
      if (binding) remember(word, binding);
    }
  }
  return { symbols, references, unsafeRename: collected?.unsafeRename ?? false };
};

const featuresFor = (source: string, uri?: string): TemplateLanguageFeatures => {
  const { symbols, references, unsafeRename } = collectSymbols(source);
  const referenceAt = (position: TemplateLanguagePosition): Reference | undefined => {
    const offset = positionToOffset(source, position);
    return references.find((reference) => reference.start <= offset && offset < reference.end);
  };
  const completion = (position: TemplateLanguagePosition): TemplateCompletionItem[] => {
    const offset = positionToOffset(source, position);
    const prefix = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(source.slice(0, offset))?.[0] ?? "";
    const variables = [...symbols.values()]
      .filter((symbol) => symbol.name.startsWith(prefix))
      .map((symbol) => ({ label: symbol.name, kind: "variable" as const, detail: symbol.detail }));
    const directives = directiveItems.filter((item) => item.label.startsWith(prefix));
    return [...new Map([...variables, ...directives].map((item) => [item.label, item])).values()];
  };
  const hover = (position: TemplateLanguagePosition): TemplateHover | undefined => {
    const reference = referenceAt(position);
    if (!reference) return undefined;
    return {
      contents: { kind: "markdown", value: `**${reference.binding.name}**\n\n${reference.binding.detail}.` },
      range: rangeFor(source, reference.start, reference.end),
    };
  };
  const definition = (position: TemplateLanguagePosition): TemplateDefinition | undefined => {
    const reference = referenceAt(position);
    if (!reference) return undefined;
    return {
      ...(uri ? { uri } : {}),
      range: rangeFor(source, reference.binding.start, reference.binding.end),
    };
  };
  const rename = (position: TemplateLanguagePosition, newName: string): TemplateRename | undefined => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) return undefined;
    // Refuse instead of producing edits that could change program meaning.
    if (unsafeRename) return undefined;
    const reference = referenceAt(position);
    if (!reference) return undefined;
    const edits = references
      .filter((candidate) => candidate.binding === reference.binding)
      .sort((left, right) => left.start - right.start)
      .map((candidate) => ({ range: rangeFor(source, candidate.start, candidate.end), newText: newName }));
    return { edits };
  };
  return {
    capabilities: { completion: true, hover: true, definition: true, rename: true },
    completion,
    hover,
    definition,
    rename,
  };
};

export const createTemplateLanguageFeatures = (source: string, uri?: string): TemplateLanguageFeatures =>
  featuresFor(source, uri);

export const templateCompletionAt = (source: string, position: TemplateLanguagePosition): TemplateCompletionItem[] =>
  featuresFor(source).completion(position);

export const templateHoverAt = (source: string, position: TemplateLanguagePosition): TemplateHover | undefined =>
  featuresFor(source).hover(position);

export const templateDefinitionAt = (
  source: string,
  position: TemplateLanguagePosition,
  uri?: string,
): TemplateDefinition | undefined => featuresFor(source, uri).definition(position);

export const templateRenameAt = (
  source: string,
  position: TemplateLanguagePosition,
  newName: string,
): TemplateRename | undefined => featuresFor(source).rename(position, newName);
