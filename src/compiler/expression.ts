import { err, ok, type Result } from "../result";
import type { CompilerError } from "./types";

export type ExpressionNode =
  | { type: "identifier"; path: string[] }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "array"; items: ExpressionNode[] }
  | { type: "object"; entries: Array<{ key: string; value: ExpressionNode }> }
  | { type: "unary"; operator: "!" | "-"; argument: ExpressionNode }
  | { type: "binary"; operator: string; left: ExpressionNode; right: ExpressionNode }
  | { type: "conditional"; test: ExpressionNode; consequent: ExpressionNode; alternate: ExpressionNode }
  | { type: "call"; callee: ExpressionNode; args: ExpressionNode[] };

type Token =
  | { type: "identifier"; value: string }
  | { type: "number"; value: string }
  | { type: "string"; value: string }
  | { type: "punct"; value: string }
  | { type: "operator"; value: string }
  | { type: "eof"; value: "" };

type Parser = {
  tokens: Token[];
  offset: number;
};

const operators = [
  "===",
  "!==",
  ">=",
  "<=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  ">",
  "<",
  "?",
  ":",
  "!",
  ".",
  ",",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
];
const binaryPrecedence = new Map([
  ["||", 1],
  ["&&", 2],
  ["===", 3],
  ["!==", 3],
  [">", 4],
  ["<", 4],
  [">=", 4],
  ["<=", 4],
  ["+", 5],
  ["-", 5],
  ["*", 6],
  ["/", 6],
  ["%", 6],
]);

const expressionError = (message: string): Result<never, CompilerError> => err({ message, offset: 0 });

const tokenize = (source: string): Result<Token[], CompilerError> => {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const char = source[offset] as string;
    if (/\s/.test(char)) {
      offset++;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = offset;
      offset++;
      while (offset < source.length && /[\w$]/.test(source[offset] as string)) {
        offset++;
      }
      tokens.push({ type: "identifier", value: source.slice(start, offset) });
      continue;
    }
    if (/\d/.test(char)) {
      const start = offset;
      offset++;
      while (offset < source.length && /[\d.]/.test(source[offset] as string)) {
        offset++;
      }
      tokens.push({ type: "number", value: source.slice(start, offset) });
      continue;
    }
    if (char === `"` || char === `'`) {
      const quote = char;
      offset++;
      let value = "";
      while (offset < source.length && source[offset] !== quote) {
        if (source[offset] === "\\") {
          value += source[offset] as string;
          offset++;
        }
        value += source[offset] as string;
        offset++;
      }
      if (source[offset] !== quote) {
        return expressionError("Unclosed string literal.");
      }
      offset++;
      tokens.push({ type: "string", value });
      continue;
    }
    const operator = operators.find((candidate) => source.startsWith(candidate, offset));
    if (!operator) {
      return expressionError(`Unsupported expression token: ${char}.`);
    }
    tokens.push(
      /[.(),[\]{}:]/.test(operator) ? { type: "punct", value: operator } : { type: "operator", value: operator },
    );
    offset += operator.length;
  }
  tokens.push({ type: "eof", value: "" });
  return ok(tokens);
};

const peek = (parser: Parser): Token => parser.tokens[parser.offset] ?? { type: "eof", value: "" };
const consume = (parser: Parser): Token => parser.tokens[parser.offset++] ?? { type: "eof", value: "" };
const match = (parser: Parser, value: string): boolean => {
  if (peek(parser).value !== value) {
    return false;
  }
  parser.offset++;
  return true;
};

const expect = (parser: Parser, value: string): Result<void, CompilerError> =>
  match(parser, value) ? ok(undefined) : expressionError(`Expected "${value}" in expression.`);

const parsePrimary = (parser: Parser): Result<ExpressionNode, CompilerError> => {
  const token = consume(parser);
  if (token.type === "identifier") {
    if (token.value === "true" || token.value === "false") {
      return ok({ type: "literal", value: token.value === "true" });
    }
    if (token.value === "null") {
      return ok({ type: "literal", value: null });
    }
    return ok({ type: "identifier", path: [token.value] });
  }
  if (token.type === "number") {
    return ok({ type: "literal", value: Number(token.value) });
  }
  if (token.type === "string") {
    return ok({ type: "literal", value: token.value });
  }
  if (token.value === "(") {
    const expression = parseExpressionInternal(parser, 0);
    if (!expression.ok) {
      return expression;
    }
    const expected = expect(parser, ")");
    return expected.ok ? expression : expected;
  }
  if (token.value === "[") {
    const items: ExpressionNode[] = [];
    while (peek(parser).value !== "]") {
      const item = parseExpressionInternal(parser, 0);
      if (!item.ok) {
        return item;
      }
      items.push(item.value);
      if (!match(parser, ",")) {
        break;
      }
    }
    const expected = expect(parser, "]");
    return expected.ok ? ok({ type: "array", items }) : expected;
  }
  if (token.value === "{") {
    const entries: Array<{ key: string; value: ExpressionNode }> = [];
    while (peek(parser).value !== "}") {
      const key = consume(parser);
      if (key.type !== "identifier" && key.type !== "string") {
        return expressionError("Expected object key.");
      }
      const colon = expect(parser, ":");
      if (!colon.ok) {
        return colon;
      }
      const value = parseExpressionInternal(parser, 0);
      if (!value.ok) {
        return value;
      }
      entries.push({ key: key.value, value: value.value });
      if (!match(parser, ",")) {
        break;
      }
    }
    const expected = expect(parser, "}");
    return expected.ok ? ok({ type: "object", entries }) : expected;
  }
  return expressionError(`Unexpected expression token: ${token.value}.`);
};

const parsePostfix = (parser: Parser): Result<ExpressionNode, CompilerError> => {
  let current = parsePrimary(parser);
  if (!current.ok) {
    return current;
  }
  while (true) {
    if (match(parser, ".")) {
      const property = consume(parser);
      if (property.type !== "identifier") {
        return expressionError("Expected property name after dot.");
      }
      if (current.value.type !== "identifier") {
        return expressionError("Only identifier paths can use dot access.");
      }
      current = ok({ type: "identifier", path: [...current.value.path, property.value] });
      continue;
    }
    if (match(parser, "(")) {
      const args: ExpressionNode[] = [];
      while (peek(parser).value !== ")") {
        const arg = parseExpressionInternal(parser, 0);
        if (!arg.ok) {
          return arg;
        }
        args.push(arg.value);
        if (!match(parser, ",")) {
          break;
        }
      }
      const expected = expect(parser, ")");
      if (!expected.ok) {
        return expected;
      }
      current = ok({ type: "call", callee: current.value, args });
      continue;
    }
    return current;
  }
};

const parseUnary = (parser: Parser): Result<ExpressionNode, CompilerError> => {
  const token = peek(parser);
  if (token.value === "!" || token.value === "-") {
    consume(parser);
    const argument = parseUnary(parser);
    return argument.ok ? ok({ type: "unary", operator: token.value as "!" | "-", argument: argument.value }) : argument;
  }
  return parsePostfix(parser);
};

const parseExpressionInternal = (parser: Parser, minPrecedence: number): Result<ExpressionNode, CompilerError> => {
  let left = parseUnary(parser);
  if (!left.ok) {
    return left;
  }
  while (true) {
    if (match(parser, "?")) {
      const consequent = parseExpressionInternal(parser, 0);
      if (!consequent.ok) {
        return consequent;
      }
      const colon = expect(parser, ":");
      if (!colon.ok) {
        return colon;
      }
      const alternate = parseExpressionInternal(parser, 0);
      if (!alternate.ok) {
        return alternate;
      }
      left = ok({ type: "conditional", test: left.value, consequent: consequent.value, alternate: alternate.value });
      continue;
    }
    const operator = peek(parser).value;
    const precedence = binaryPrecedence.get(operator);
    if (!precedence || precedence < minPrecedence) {
      return left;
    }
    consume(parser);
    const right = parseExpressionInternal(parser, precedence + 1);
    if (!right.ok) {
      return right;
    }
    left = ok({ type: "binary", operator, left: left.value, right: right.value });
  }
};

export const parseExpression = (source: string): Result<ExpressionNode, CompilerError> => {
  const tokens = tokenize(source);
  if (!tokens.ok) {
    return tokens;
  }
  const parser: Parser = { tokens: tokens.value, offset: 0 };
  const expression = parseExpressionInternal(parser, 0);
  if (!expression.ok) {
    return expression;
  }
  if (peek(parser).type !== "eof") {
    return expressionError(`Unexpected expression token: ${peek(parser).value}.`);
  }
  return expression;
};

const readPath = (scope: Record<string, unknown>, path: readonly string[]): unknown => {
  let current: unknown = scope;
  for (const part of path) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

export const evaluateExpressionNode = (node: ExpressionNode, scope: Record<string, unknown>): unknown => {
  if (node.type === "identifier") {
    return readPath(scope, node.path);
  }
  if (node.type === "literal") {
    return node.value;
  }
  if (node.type === "array") {
    return node.items.map((item) => evaluateExpressionNode(item, scope));
  }
  if (node.type === "object") {
    return Object.fromEntries(node.entries.map((entry) => [entry.key, evaluateExpressionNode(entry.value, scope)]));
  }
  if (node.type === "unary") {
    const value = evaluateExpressionNode(node.argument, scope);
    return node.operator === "!" ? !value : -Number(value);
  }
  if (node.type === "conditional") {
    return evaluateExpressionNode(node.test, scope)
      ? evaluateExpressionNode(node.consequent, scope)
      : evaluateExpressionNode(node.alternate, scope);
  }
  if (node.type === "call") {
    const callee = evaluateExpressionNode(node.callee, scope);
    if (typeof callee !== "function") {
      return undefined;
    }
    return callee(...node.args.map((arg) => evaluateExpressionNode(arg, scope)));
  }
  const left = evaluateExpressionNode(node.left, scope);
  const right = evaluateExpressionNode(node.right, scope);
  if (node.operator === "===") return left === right;
  if (node.operator === "!==") return left !== right;
  if (node.operator === "&&") return left && right;
  if (node.operator === "||") return left || right;
  if (node.operator === "+") {
    return typeof left === "string" || typeof right === "string"
      ? `${left ?? ""}${right ?? ""}`
      : Number(left) + Number(right);
  }
  if (node.operator === "-") return Number(left) - Number(right);
  if (node.operator === "*") return Number(left) * Number(right);
  if (node.operator === "/") return Number(left) / Number(right);
  if (node.operator === "%") return Number(left) % Number(right);
  if (node.operator === ">") return Number(left) > Number(right);
  if (node.operator === "<") return Number(left) < Number(right);
  if (node.operator === ">=") return Number(left) >= Number(right);
  return Number(left) <= Number(right);
};

export const evaluateExpression = (source: string, scope: Record<string, unknown>): unknown => {
  const parsed = parseExpression(source);
  return parsed.ok ? evaluateExpressionNode(parsed.value, scope) : undefined;
};

export const expressionToJs = (
  source: string,
  locals: ReadonlySet<string> = new Set(),
  scopeName = "scope",
): string => {
  const parsed = parseExpression(source);
  return parsed.ok ? expressionNodeToJs(parsed.value, locals, scopeName) : "undefined";
};

export const expressionNodeToJs = (
  node: ExpressionNode,
  locals: ReadonlySet<string> = new Set(),
  scopeName = "scope",
): string => {
  if (node.type === "identifier") {
    const [head, ...tail] = node.path;
    const root = head && locals.has(head) ? head : `${scopeName}.${head ?? ""}`;
    return [root, ...tail].join(".");
  }
  if (node.type === "literal") {
    return JSON.stringify(node.value);
  }
  if (node.type === "array") {
    return `[${node.items.map((item) => expressionNodeToJs(item, locals, scopeName)).join(", ")}]`;
  }
  if (node.type === "object") {
    return `{ ${node.entries
      .map((entry) => `${JSON.stringify(entry.key)}: ${expressionNodeToJs(entry.value, locals, scopeName)}`)
      .join(", ")} }`;
  }
  if (node.type === "unary") {
    return `(${node.operator}${expressionNodeToJs(node.argument, locals, scopeName)})`;
  }
  if (node.type === "conditional") {
    return `(${expressionNodeToJs(node.test, locals, scopeName)} ? ${expressionNodeToJs(
      node.consequent,
      locals,
      scopeName,
    )} : ${expressionNodeToJs(node.alternate, locals, scopeName)})`;
  }
  if (node.type === "call") {
    return `${expressionNodeToJs(node.callee, locals, scopeName)}(${node.args
      .map((arg) => expressionNodeToJs(arg, locals, scopeName))
      .join(", ")})`;
  }
  return `(${expressionNodeToJs(node.left, locals, scopeName)} ${node.operator} ${expressionNodeToJs(
    node.right,
    locals,
    scopeName,
  )})`;
};

export const isAssignableExpression = (source: string): boolean => {
  const parsed = parseExpression(source);
  return parsed.ok && parsed.value.type === "identifier";
};
