import type { RawTextScanResult, RawTextScanState } from "../../src/html-raw-text.js";

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

const firstCandidate = (left: number, right: number): number => {
  if (left < 0) return right;
  if (right < 0) return left;
  return Math.min(left, right);
};

export const scanRawTextWithNativeSearch = (
  input: string,
  offset: number,
  initialState: RawTextScanState,
): RawTextScanResult => {
  let scriptState = initialState.scriptState;
  const closingToken = `</${initialState.tagName}`;
  let index = offset;

  while (index < input.length) {
    if (initialState.tagName === "style") {
      const candidate = input.indexOf("<", index);
      if (candidate < 0) break;
      if (matchesTagToken(input, candidate, closingToken)) {
        return { closingTagStart: candidate, state: { ...initialState, scriptState } };
      }
      index = candidate + 1;
      continue;
    }

    if (scriptState === "data") {
      const candidate = input.indexOf("<", index);
      if (candidate < 0) break;
      if (matchesTagToken(input, candidate, closingToken)) {
        return { closingTagStart: candidate, state: { ...initialState, scriptState } };
      }
      if (input.startsWith("<!--", candidate)) {
        scriptState = "escaped";
        index = candidate + 4;
      } else {
        index = candidate + 1;
      }
      continue;
    }

    const tagCandidate = input.indexOf("<", index);
    const commentCloseCandidate = input.indexOf("-->", index);
    const candidate = firstCandidate(tagCandidate, commentCloseCandidate);
    if (candidate < 0) break;

    if (candidate === commentCloseCandidate) {
      scriptState = "data";
      index = candidate + 3;
      continue;
    }

    if (scriptState === "escaped") {
      if (matchesTagToken(input, candidate, closingToken)) {
        return { closingTagStart: candidate, state: { ...initialState, scriptState } };
      }
      if (matchesTagToken(input, candidate, "<script")) {
        scriptState = "double-escaped";
        index = candidate + "<script".length;
      } else {
        index = candidate + 1;
      }
      continue;
    }

    if (matchesTagToken(input, candidate, "</script")) {
      scriptState = "escaped";
      index = candidate + "</script".length;
    } else {
      index = candidate + 1;
    }
  }

  return { closingTagStart: -1, state: { ...initialState, scriptState } };
};
