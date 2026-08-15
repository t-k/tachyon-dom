import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";

export type HtmlWhitespacePolicy = "preserve-tags" | "normalize-tags";

export const resolveHtmlWhitespacePolicy = (policy: unknown): HtmlWhitespacePolicy => {
  if (policy === "preserve-tags" || policy === "preserve") return "preserve-tags";
  if (policy === "normalize-tags" || policy === "condense") return "normalize-tags";
  throw new TypeError(
    `Unsupported HTML whitespace policy ${JSON.stringify(policy)}. For migration, use "preserve-tags" or "normalize-tags".`,
  );
};

type SourceRange = { startOffset: number; endOffset: number };
type LocatedNode = DefaultTreeAdapterMap["node"] & {
  childNodes?: LocatedNode[];
  content?: LocatedNode;
  sourceCodeLocation?: {
    startTag?: SourceRange;
    endTag?: SourceRange;
  };
};

const isHtmlSpace = (character: string): boolean =>
  character === " " || character === "\t" || character === "\n" || character === "\f" || character === "\r";

const condenseTag = (source: string): string => {
  let output = "";
  let cursor = 0;
  let quote: '"' | "'" | undefined;
  while (cursor < source.length) {
    const character = source[cursor] ?? "";
    if (quote) {
      output += character;
      if (character === quote) quote = undefined;
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      cursor += 1;
      continue;
    }
    if (isHtmlSpace(character)) {
      let next = cursor + 1;
      while (next < source.length && isHtmlSpace(source[next] ?? "")) next += 1;
      if (source[next] !== ">") output += " ";
      cursor = next;
      continue;
    }
    output += character;
    cursor += 1;
  }
  return output;
};

const collectTagRanges = (node: LocatedNode, ranges: SourceRange[]): void => {
  const location = node.sourceCodeLocation;
  if (location?.startTag) ranges.push(location.startTag);
  if (location?.endTag) ranges.push(location.endTag);
  for (const child of node.childNodes ?? []) collectTagRanges(child, ranges);
  if (node.content) collectTagRanges(node.content, ranges);
};

export const normalizeHtmlTagWhitespace = (html: string): string => {
  const errors: unknown[] = [];
  const options = {
    sourceCodeLocationInfo: true,
    onParseError: (error: unknown) => errors.push(error),
  };
  const document = (
    /<!doctype\b|<html\b/i.test(html) ? parse(html, options) : parseFragment(html, options)
  ) as LocatedNode;
  if (errors.length > 0) return html;

  const ranges: SourceRange[] = [];
  collectTagRanges(document, ranges);
  ranges.sort((left, right) => left.startOffset - right.startOffset);
  let cursor = 0;
  let output = "";
  for (const range of ranges) {
    if (
      range.startOffset < cursor ||
      range.startOffset < 0 ||
      range.endOffset > html.length ||
      range.endOffset <= range.startOffset
    ) {
      return html;
    }
    output += html.slice(cursor, range.startOffset);
    output += condenseTag(html.slice(range.startOffset, range.endOffset));
    cursor = range.endOffset;
  }
  return `${output}${html.slice(cursor)}`;
};

/** @deprecated Use `normalizeHtmlTagWhitespace()`. */
export const condenseHtmlWhitespace = normalizeHtmlTagWhitespace;

export const applyHtmlWhitespace = (html: string, policy: HtmlWhitespacePolicy): string =>
  resolveHtmlWhitespacePolicy(policy) === "normalize-tags" ? normalizeHtmlTagWhitespace(html) : html;
