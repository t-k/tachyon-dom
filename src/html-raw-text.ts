export type RawTextTag = "script" | "style";
export type ScriptDataState = "data" | "escaped" | "double-escaped";

export type RawTextScanState = {
  tagName: RawTextTag;
  scriptState: ScriptDataState;
};

export type RawTextScanResult = {
  closingTagStart: number;
  state: RawTextScanState;
};

const asciiLowerCode = (code: number): number => (code >= 65 && code <= 90 ? code + 32 : code);

const startsWithAsciiInsensitive = (input: string, offset: number, expected: string): boolean => {
  if (offset + expected.length > input.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (asciiLowerCode(input.charCodeAt(offset + index)) !== expected.charCodeAt(index)) return false;
  }
  return true;
};

const isTagBoundary = (value: string | undefined): boolean =>
  value === ">" ||
  value === "/" ||
  value === " " ||
  value === "\t" ||
  value === "\n" ||
  value === "\f" ||
  value === "\r";

const matchesTagToken = (input: string, offset: number, token: string): boolean =>
  startsWithAsciiInsensitive(input, offset, token) && isTagBoundary(input[offset + token.length]);

export const scanRawText = (input: string, offset: number, initialState: RawTextScanState): RawTextScanResult => {
  let scriptState = initialState.scriptState;
  const closingToken = `</${initialState.tagName}`;
  for (let index = offset; index < input.length; ) {
    if (initialState.tagName === "style") {
      if (matchesTagToken(input, index, closingToken)) {
        return { closingTagStart: index, state: { ...initialState, scriptState } };
      }
      index += 1;
      continue;
    }

    if (scriptState === "data") {
      if (matchesTagToken(input, index, closingToken)) {
        return { closingTagStart: index, state: { ...initialState, scriptState } };
      }
      if (input.startsWith("<!--", index)) {
        scriptState = "escaped";
        index += 4;
        continue;
      }
    } else if (scriptState === "escaped") {
      if (matchesTagToken(input, index, closingToken)) {
        return { closingTagStart: index, state: { ...initialState, scriptState } };
      }
      if (matchesTagToken(input, index, "<script")) {
        scriptState = "double-escaped";
        index += "<script".length;
        continue;
      }
      if (input.startsWith("-->", index)) {
        scriptState = "data";
        index += 3;
        continue;
      }
    } else {
      if (matchesTagToken(input, index, "</script")) {
        scriptState = "escaped";
        index += "</script".length;
        continue;
      }
      if (input.startsWith("-->", index)) {
        scriptState = "data";
        index += 3;
        continue;
      }
    }
    index += 1;
  }
  return { closingTagStart: -1, state: { ...initialState, scriptState } };
};
