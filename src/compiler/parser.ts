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
  let quote: string | undefined;
  const start = parser.offset;
  while (parser.offset < parser.source.length) {
    const char = parser.source[parser.offset] as string;
    const previous = parser.source[parser.offset - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = undefined;
      }
      parser.offset++;
      continue;
    }
    if (char === `"` || char === `'`) {
      quote = char;
      parser.offset++;
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      parser.offset++;
      if (depth === 0) {
        return ok(parser.source.slice(start, parser.offset));
      }
      continue;
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
    const nameResult = readName(parser);
    if (!nameResult.ok) {
      return err(nameResult.error);
    }
    consumeWhitespace(parser);
    if (peek(parser) !== "=") {
      attrs.push({ name: nameResult.value, value: true });
      continue;
    }
    parser.offset++;
    consumeWhitespace(parser);
    const valueResult = readAttributeValue(parser);
    if (!valueResult.ok) {
      return err(valueResult.error);
    }
    attrs.push({ name: nameResult.value, value: valueResult.value });
  }
  return parserError(parser, "Unclosed attribute list.");
};

const parseText = (parser: Parser): TextNode => {
  const start = parser.offset;
  while (parser.offset < parser.source.length && peek(parser) !== "<") {
    parser.offset++;
  }
  return { type: "text", value: parser.source.slice(start, parser.offset) };
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
    return ok({ type: "element", start, tagName: tagNameResult.value, attrs: attrsResult.value, children: [] });
  }
  if (peek(parser) !== ">") {
    return parserError(parser, "Expected end of opening tag.");
  }
  parser.offset++;
  if (voidElementNames.has(tagNameResult.value)) {
    if (startsWith(parser, `</${tagNameResult.value}`)) {
      const closing = consumeClosingTag(parser, tagNameResult.value);
      if (!closing.ok) {
        return err(closing.error);
      }
    }
    return ok({ type: "element", start, tagName: tagNameResult.value, attrs: attrsResult.value, children: [] });
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
  return ok({ type: "element", start, tagName: tagNameResult.value, attrs: attrsResult.value, children });
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
