export type HtmlWhitespacePolicy = "preserve" | "condense";

const rawTextElements = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "pre",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

type TagToken = {
  end: number;
  name: string | undefined;
  closing: boolean;
  selfClosing: boolean;
};

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
    if (/\s/.test(character)) {
      let next = cursor + 1;
      while (next < source.length && /\s/.test(source[next] ?? "")) next += 1;
      const nextCharacter = source[next];
      if (nextCharacter !== ">" && nextCharacter !== "/") output += " ";
      cursor = next;
      continue;
    }
    output += character;
    cursor += 1;
  }
  return output;
};

const readTag = (html: string, start: number): TagToken => {
  if (html.startsWith("<!--", start)) {
    const commentEnd = html.indexOf("-->", start + 4);
    return { end: commentEnd < 0 ? html.length : commentEnd + 3, name: undefined, closing: false, selfClosing: true };
  }

  let cursor = start + 1;
  const closing = html[cursor] === "/";
  if (closing) cursor += 1;
  while (cursor < html.length && /\s/.test(html[cursor] ?? "")) cursor += 1;
  const nameStart = cursor;
  while (cursor < html.length && /[A-Za-z0-9:-]/.test(html[cursor] ?? "")) cursor += 1;
  const name = cursor > nameStart ? html.slice(nameStart, cursor).toLowerCase() : undefined;
  let quote: '"' | "'" | undefined;
  for (; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      const source = html.slice(start, cursor + 1);
      return { end: cursor + 1, name, closing, selfClosing: /\/\s*>$/.test(source) };
    }
  }
  return { end: html.length, name, closing, selfClosing: false };
};

export const condenseHtmlWhitespace = (html: string): string => {
  let cursor = 0;
  let rawTextElement: string | undefined;
  let output = "";
  const lowerHtml = html.toLowerCase();

  while (cursor < html.length) {
    if (rawTextElement) {
      const closing = lowerHtml.indexOf(`</${rawTextElement}`, cursor);
      if (closing < 0) return html;
      output += html.slice(cursor, closing);
      cursor = closing;
      rawTextElement = undefined;
      continue;
    }
    if (html[cursor] !== "<") {
      const nextTag = html.indexOf("<", cursor);
      const end = nextTag < 0 ? html.length : nextTag;
      output += html.slice(cursor, end);
      cursor = end;
      continue;
    }

    const tag = readTag(html, cursor);
    const source = html.slice(cursor, tag.end);
    if (!source.endsWith(">")) return html;
    output += tag.name ? condenseTag(source) : source;
    if (tag.name && !tag.closing && !tag.selfClosing && rawTextElements.has(tag.name)) {
      rawTextElement = tag.name;
    }
    cursor = tag.end;
  }

  return output;
};

export const applyHtmlWhitespace = (html: string, policy: HtmlWhitespacePolicy): string =>
  policy === "condense" ? condenseHtmlWhitespace(html) : html;
