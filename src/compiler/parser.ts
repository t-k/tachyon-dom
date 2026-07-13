import { err, ok, type Result } from "../result.js";
import type { Attribute, CompilerError, ElementNode, TextNode } from "./types.js";
import { voidElementNames } from "./utils.js";

type Parser = {
  source: string;
  offset: number;
};

const isWhitespace = (char: string | undefined): boolean =>
  char === " " || char === "\n" || char === "\t" || char === "\r";

const parserError = (parser: Parser, message: string): Result<never, CompilerError> =>
  err({ message, offset: parser.offset });

const peek = (parser: Parser): string | undefined => parser.source[parser.offset];

const startsWith = (parser: Parser, value: string): boolean => parser.source.startsWith(value, parser.offset);

const consumeWhitespace = (parser: Parser): void => {
  while (isWhitespace(peek(parser))) {
    parser.offset++;
  }
};

const readWhile = (parser: Parser, predicate: (char: string) => boolean): string => {
  const start = parser.offset;
  while (parser.offset < parser.source.length) {
    const char = parser.source[parser.offset] as string;
    if (!predicate(char)) {
      break;
    }
    parser.offset++;
  }
  return parser.source.slice(start, parser.offset);
};

const readName = (parser: Parser): Result<string, CompilerError> => {
  const name = readWhile(parser, (char) => /[A-Za-z0-9:_$.-]/.test(char));
  if (!name) {
    return parserError(parser, "Expected a name.");
  }
  return ok(name);
};

const readQuotedValue = (parser: Parser): Result<string, CompilerError> => {
  const quote = peek(parser);
  if (quote !== `"` && quote !== `'`) {
    return parserError(parser, "Expected a quoted attribute value.");
  }
  parser.offset++;
  const start = parser.offset;
  while (parser.offset < parser.source.length && peek(parser) !== quote) {
    parser.offset++;
  }
  if (peek(parser) !== quote) {
    return parserError(parser, "Unclosed attribute value.");
  }
  const value = parser.source.slice(start, parser.offset);
  parser.offset++;
  return ok(value);
};

const readBracedValue = (parser: Parser): Result<string, CompilerError> => {
  let depth = 0;
  let mode: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" | "regex" =
    "code";
  let escaped = false;
  let regexCharacterClass = false;
  let canStartRegex = true;
  const templateExpressionDepths: number[] = [];
  const start = parser.offset;
  while (parser.offset < parser.source.length) {
    const char = parser.source[parser.offset] as string;
    const next = parser.source[parser.offset + 1];
    if (mode === "line-comment") {
      if (char === "\n" || char === "\r") mode = "code";
      parser.offset++;
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        parser.offset += 2;
      } else {
        parser.offset++;
      }
      continue;
    }
    if (mode === "single" || mode === "double") {
      if (!escaped && char === (mode === "single" ? "'" : '"')) mode = "code";
      escaped = !escaped && char === "\\";
      parser.offset++;
      continue;
    }
    if (mode === "regex") {
      if (!escaped) {
        if (char === "[") regexCharacterClass = true;
        if (char === "]") regexCharacterClass = false;
        if (char === "/" && !regexCharacterClass) {
          mode = "code";
          canStartRegex = false;
        }
      }
      escaped = !escaped && char === "\\";
      parser.offset++;
      continue;
    }
    if (mode === "template") {
      if (!escaped && char === "`" ) {
        mode = "code";
        canStartRegex = false;
        parser.offset++;
        continue;
      }
      if (!escaped && char === "$" && next === "{") {
        depth++;
        templateExpressionDepths.push(depth);
        mode = "code";
        canStartRegex = true;
        parser.offset += 2;
        continue;
      }
      escaped = !escaped && char === "\\";
      parser.offset++;
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line-comment";
      parser.offset += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      mode = "block-comment";
      parser.offset += 2;
      continue;
    }
    if (char === "/" && canStartRegex) {
      mode = "regex";
      escaped = false;
      regexCharacterClass = false;
      parser.offset++;
      continue;
    }
    if (char === `"` || char === `'` || char === "`") {
      mode = char === `"` ? "double" : char === `'` ? "single" : "template";
      escaped = false;
      parser.offset++;
      continue;
    }
    if (char === "{") {
      depth++;
      canStartRegex = true;
    } else if (char === "}") {
      depth--;
      parser.offset++;
      if (templateExpressionDepths.at(-1) === depth + 1) {
        templateExpressionDepths.pop();
        mode = "template";
        escaped = false;
        continue;
      }
      if (depth === 0) {
        return ok(parser.source.slice(start, parser.offset));
      }
      canStartRegex = false;
      continue;
    } else if (!isWhitespace(char)) {
      canStartRegex = "([,:;!?=+-*%&|^~<>".includes(char);
    }
    parser.offset++;
  }
  return parserError(parser, "Unclosed braced attribute value.");
};

const readAttributeValue = (parser: Parser): Result<string, CompilerError> => {
  if (peek(parser) === `"` || peek(parser) === `'`) {
    return readQuotedValue(parser);
  }
  if (peek(parser) === "{") {
    return readBracedValue(parser);
  }
  return ok(readWhile(parser, (char) => !isWhitespace(char) && char !== ">" && char !== "/"));
};

const parseAttributes = (parser: Parser): Result<Attribute[], CompilerError> => {
  const attrs: Attribute[] = [];
  while (parser.offset < parser.source.length) {
    consumeWhitespace(parser);
    const char = peek(parser);
    if (char === ">" || startsWith(parser, "/>")) {
      return ok(attrs);
    }
    const start = parser.offset;
    const nameStart = parser.offset;
    const nameResult = readName(parser);
    if (!nameResult.ok) {
      return err(nameResult.error);
    }
    const nameEnd = parser.offset;
    consumeWhitespace(parser);
    if (peek(parser) !== "=") {
      attrs.push({ name: nameResult.value, value: true, start, end: nameEnd, nameStart, nameEnd });
      continue;
    }
    parser.offset++;
    consumeWhitespace(parser);
    const valueStart = parser.offset;
    const valueResult = readAttributeValue(parser);
    if (!valueResult.ok) {
      return err(valueResult.error);
    }
    const valueEnd = parser.offset;
    attrs.push({
      name: nameResult.value,
      value: valueResult.value,
      start,
      end: valueEnd,
      nameStart,
      nameEnd,
      valueStart,
      valueEnd,
    });
  }
  return parserError(parser, "Unclosed attribute list.");
};

const parseText = (parser: Parser): TextNode => {
  const start = parser.offset;
  while (parser.offset < parser.source.length && peek(parser) !== "<") {
    parser.offset++;
  }
  return { type: "text", value: parser.source.slice(start, parser.offset), start, end: parser.offset };
};

const consumeComment = (parser: Parser): Result<void, CompilerError> => {
  if (!startsWith(parser, "<!--")) {
    return parserError(parser, "Expected an HTML comment.");
  }
  const end = parser.source.indexOf("-->", parser.offset + 4);
  if (end === -1) {
    return parserError(parser, "Unclosed HTML comment.");
  }
  parser.offset = end + 3;
  return ok(undefined);
};

const consumeClosingTag = (parser: Parser, tagName: string): Result<void, CompilerError> => {
  if (!startsWith(parser, `</${tagName}`)) {
    return parserError(parser, `Missing closing tag for <${tagName}>.`);
  }
  parser.offset += tagName.length + 2;
  consumeWhitespace(parser);
  if (peek(parser) !== ">") {
    return parserError(parser, "Expected end of closing tag.");
  }
  parser.offset++;
  return ok(undefined);
};

const parseElement = (parser: Parser): Result<ElementNode, CompilerError> => {
  const start = parser.offset;
  if (peek(parser) !== "<") {
    return parserError(parser, "Expected an opening tag.");
  }
  if (startsWith(parser, "<!--")) {
    return parserError(parser, "Unexpected HTML comment.");
  }
  parser.offset++;
  if (peek(parser) === "/") {
    return parserError(parser, "Unexpected closing tag.");
  }

  const tagNameResult = readName(parser);
  if (!tagNameResult.ok) {
    return err(tagNameResult.error);
  }
  const attrsResult = parseAttributes(parser);
  if (!attrsResult.ok) {
    return err(attrsResult.error);
  }
  if (startsWith(parser, "/>")) {
    parser.offset += 2;
    return ok({ type: "element", start, end: parser.offset, openEnd: parser.offset, tagName: tagNameResult.value, attrs: attrsResult.value, children: [] });
  }
  if (peek(parser) !== ">") {
    return parserError(parser, "Expected end of opening tag.");
  }
  parser.offset++;
  const openEnd = parser.offset;
  if (voidElementNames.has(tagNameResult.value)) {
    if (startsWith(parser, `</${tagNameResult.value}`)) {
      const closing = consumeClosingTag(parser, tagNameResult.value);
      if (!closing.ok) {
        return err(closing.error);
      }
    }
    return ok({ type: "element", start, end: parser.offset, openEnd, tagName: tagNameResult.value, attrs: attrsResult.value, children: [] });
  }

  const children = [];
  while (parser.offset < parser.source.length && !startsWith(parser, `</${tagNameResult.value}`)) {
    if (startsWith(parser, "<!--")) {
      const comment = consumeComment(parser);
      if (!comment.ok) {
        return err(comment.error);
      }
    } else if (peek(parser) === "<") {
      const childResult = parseElement(parser);
      if (!childResult.ok) {
        return err(childResult.error);
      }
      children.push(childResult.value);
    } else {
      children.push(parseText(parser));
    }
  }

  const closing = consumeClosingTag(parser, tagNameResult.value);
  if (!closing.ok) {
    return err(closing.error);
  }
  return ok({ type: "element", start, end: parser.offset, openEnd, tagName: tagNameResult.value, attrs: attrsResult.value, children });
};

export const parseTemplate = (source: string): Result<ElementNode, CompilerError> => {
  const parser: Parser = { source, offset: 0 };
  consumeWhitespace(parser);
  const rootResult = parseElement(parser);
  if (!rootResult.ok) {
    return err(rootResult.error);
  }
  consumeWhitespace(parser);
  if (parser.offset !== source.length) {
    return err({ message: "Only one root element is currently supported.", offset: parser.offset });
  }
  return rootResult;
};
