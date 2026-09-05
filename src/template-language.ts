import { parseTachyonSfc } from "./compiler/sfc.js";

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

const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const declarationPattern = /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const importPattern = /\bimport\s+(?:type\s+)?(?:\{([^}]*)\}|([A-Za-z_$][A-Za-z0-9_$]*))/g;
const reservedWords = new Set([
  "as",
  "await",
  "const",
  "else",
  "false",
  "for",
  "function",
  "if",
  "in",
  "let",
  "new",
  "null",
  "of",
  "return",
  "true",
  "undefined",
  "var",
]);
const directiveItems: TemplateCompletionItem[] = [
  { label: "if", kind: "directive", detail: "Conditional template block" },
  { label: "for", kind: "directive", detail: "Keyed list template block" },
  { label: "await", kind: "directive", detail: "Async template block" },
  { label: "component", kind: "directive", detail: "Transparent component boundary" },
  { label: "store", kind: "directive", detail: "Local reactive store" },
  { label: "hydrate", kind: "directive", detail: "Hydration boundary" },
  { label: "bind", kind: "directive", detail: "Two-way control binding" },
];

const wordAt = (source: string, offset: number): Word | undefined => {
  const clamped = Math.max(0, Math.min(source.length, offset));
  let start = clamped;
  while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1] as string)) start--;
  let end = clamped;
  while (end < source.length && /[A-Za-z0-9_$]/.test(source[end] as string)) end++;
  if (start === end) return undefined;
  return { name: source.slice(start, end), start, end };
};

const positionToOffset = (source: string, position: TemplateLanguagePosition): number => {
  let offset = 0;
  let line = 0;
  while (line < position.line && offset < source.length) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return source.length;
    offset = newline + 1;
    line++;
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
  if (!existing || (existing.kind === "template" && symbol.kind === "script")) {
    symbols.set(symbol.name, symbol);
  }
};

const expressionWords = (expression: string, offset: number): Word[] => {
  const words: Word[] = [];
  for (let index = 0; index < expression.length; index++) {
    identifierPattern.lastIndex = index;
    const match = identifierPattern.exec(expression);
    if (!match) continue;
    const start = match.index;
    const name = match[0] as string;
    index = start + name.length - 1;
    const previous = expression[start - 1];
    if (previous === "." || reservedWords.has(name)) continue;
    words.push({ name, start: offset + start, end: offset + start + name.length });
  }
  return words;
};

const collectSymbols = (source: string): { symbols: Map<string, SymbolInfo>; referenceOffsets: Map<string, Word[]> } => {
  const symbols = new Map<string, SymbolInfo>();
  const referenceOffsets = new Map<string, Word[]>();
  const descriptor = parseTachyonSfc(source);
  const templateOffset = descriptor.ok && descriptor.value.script
    ? source.indexOf(">", descriptor.value.script.offset + descriptor.value.script.content.length) + 1
    : 0;
  const template = descriptor.ok ? descriptor.value.template : source;
  const script = descriptor.ok ? descriptor.value.script : undefined;
  const rememberReference = (word: Word): void => {
    const references = referenceOffsets.get(word.name) ?? [];
    references.push(word);
    referenceOffsets.set(word.name, references);
  };
  if (script) {
    for (const match of script.content.matchAll(declarationPattern)) {
      const name = match[1] as string;
      const relative = (match.index ?? 0) + (match[0]?.lastIndexOf(name) ?? 0);
      addSymbol(symbols, {
        name,
        start: script.offset + relative,
        end: script.offset + relative + name.length,
        kind: "script",
        detail: "Declared in the component script",
      });
    }
    for (const match of script.content.matchAll(importPattern)) {
      const names = match[1]
        ? match[1].split(",").flatMap((part) => {
            const name = /(?:as\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(part.trim())?.[1];
            return name ? [name] : [];
          })
        : match[2]
          ? [match[2]]
          : [];
      for (const name of names) {
        const relative = (match.index ?? 0) + match[0].lastIndexOf(name);
        addSymbol(symbols, {
          name,
          start: script.offset + relative,
          end: script.offset + relative + name.length,
          kind: "script",
          detail: "Imported in the component script",
        });
      }
    }
    for (const match of script.content.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      rememberReference({
        name: match[0] as string,
        start: script.offset + (match.index ?? 0),
        end: script.offset + (match.index ?? 0) + (match[0]?.length ?? 0),
      });
    }
  }
  const addTemplateWord = (word: Word, detail: string): void => {
    addSymbol(symbols, { ...word, kind: "template", detail });
    rememberReference(word);
  };
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    const expressionOffset = templateOffset + (match.index ?? 0) + 1;
    for (const word of expressionWords(match[1] as string, expressionOffset)) rememberReference(word);
  }
  for (const match of template.matchAll(/\b(?:as|index|then)\s*=\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g)) {
    const name = match[1] as string;
    const relative = (match.index ?? 0) + match[0].lastIndexOf(name);
    addTemplateWord(
      { name, start: templateOffset + relative, end: templateOffset + relative + name.length },
      "Local template binding",
    );
  }
  for (const match of template.matchAll(/<(?:component|store)\b[^>]*\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\{/g)) {
    const name = match[1] as string;
    const relative = (match.index ?? 0) + match[0].lastIndexOf(name);
    addTemplateWord(
      { name, start: templateOffset + relative, end: templateOffset + relative + name.length },
      "Local template binding",
    );
  }
  return { symbols, referenceOffsets };
};

const featuresFor = (source: string, uri?: string): TemplateLanguageFeatures => {
  const { symbols, referenceOffsets } = collectSymbols(source);
  const completion = (position: TemplateLanguagePosition): TemplateCompletionItem[] => {
    const offset = positionToOffset(source, position);
    const prefix = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(source.slice(0, offset))?.[0] ?? "";
    const variables = [...symbols.values()]
      .filter((symbol) => symbol.name.startsWith(prefix))
      .map((symbol) => ({ label: symbol.name, kind: "variable" as const, detail: symbol.detail }));
    const directives = directiveItems.filter((item) => item.label.startsWith(prefix));
    return [...new Map([...variables, ...directives].map((item) => [item.label, item])).values()];
  };
  const wordForPosition = (position: TemplateLanguagePosition): Word | undefined =>
    wordAt(source, positionToOffset(source, position));
  const hover = (position: TemplateLanguagePosition): TemplateHover | undefined => {
    const word = wordForPosition(position);
    if (!word) return undefined;
    const symbol = symbols.get(word.name);
    if (!symbol) return undefined;
    return {
      contents: { kind: "markdown", value: `**${symbol.name}**\n\n${symbol.detail}.` },
      range: rangeFor(source, word.start, word.end),
    };
  };
  const definition = (position: TemplateLanguagePosition): TemplateDefinition | undefined => {
    const word = wordForPosition(position);
    const symbol = word ? symbols.get(word.name) : undefined;
    if (!symbol) return undefined;
    return { ...(uri ? { uri } : {}), range: rangeFor(source, symbol.start, symbol.end) };
  };
  const rename = (position: TemplateLanguagePosition, newName: string): TemplateRename | undefined => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) return undefined;
    const word = wordForPosition(position);
    if (!word || !symbols.has(word.name)) return undefined;
    const edits = (referenceOffsets.get(word.name) ?? [])
      .sort((left, right) => left.start - right.start)
      .map((reference) => ({ range: rangeFor(source, reference.start, reference.end), newText: newName }));
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
