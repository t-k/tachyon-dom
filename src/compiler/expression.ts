import type { Expression as OxcExpression, ParseResult, ParserOptions } from "oxc-parser";
import { err, ok, type Result } from "../result.js";
import type { CompilerError } from "./types.js";

export type ExpressionParserBackend = "auto" | "native" | "oxc";

export type ExpressionAliases = ReadonlyMap<string, string>;

export type ExpressionParseOptions = {
  backend?: ExpressionParserBackend;
};

export type ExpressionNode =
  | { type: "identifier"; path: string[] }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "regex"; pattern: string; flags: string }
  | { type: "array"; items: ExpressionNode[] }
  | { type: "object"; entries: Array<{ key: string; value: ExpressionNode }> }
  | { type: "unary"; operator: "!" | "-"; argument: ExpressionNode }
  | { type: "binary"; operator: string; left: ExpressionNode; right: ExpressionNode }
  | { type: "conditional"; test: ExpressionNode; consequent: ExpressionNode; alternate: ExpressionNode }
  | { type: "call"; callee: ExpressionNode; args: ExpressionNode[] }
  | { type: "member"; object: ExpressionNode; property: ExpressionNode; computed: boolean; optional: boolean }
  | { type: "template"; parts: Array<string | ExpressionNode> };

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
  "==",
  "!=",
  "??",
  "?.",
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
const operatorsByFirstChar = new Map<string, string[]>();
for (const operator of operators) {
  const first = operator[0] as string;
  const entries = operatorsByFirstChar.get(first) ?? [];
  entries.push(operator);
  entries.sort((left, right) => right.length - left.length);
  operatorsByFirstChar.set(first, entries);
}
const binaryPrecedence = new Map([
  ["||", 1],
  ["??", 1],
  ["&&", 2],
  ["==", 3],
  ["!=", 3],
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
const expressionCacheLimit = 512;
const expressionCache = new Map<string, Result<ExpressionNode, CompilerError>>();
const deniedPropertyNames = new Set(["constructor", "__proto__", "prototype"]);
const deniedPropertyNameList = [...deniedPropertyNames];

const cacheKeyFor = (source: string, backend: ExpressionParserBackend): string => `${backend}\u0000${source}`;

const rememberExpression = (
  key: string,
  result: Result<ExpressionNode, CompilerError>,
): Result<ExpressionNode, CompilerError> => {
  if (expressionCache.has(key)) {
    expressionCache.delete(key);
  }
  expressionCache.set(key, result);
  while (expressionCache.size > expressionCacheLimit) {
    const oldest = expressionCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    expressionCache.delete(oldest);
  }
  return result;
};

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
          offset++;
          const escaped = source[offset] as string | undefined;
          if (escaped === undefined) {
            return expressionError("Unclosed string literal.");
          }
          value +=
            escaped === "n"
              ? "\n"
              : escaped === "r"
                ? "\r"
                : escaped === "t"
                  ? "\t"
                  : escaped === "b"
                    ? "\b"
                    : escaped === "f"
                      ? "\f"
                      : escaped === "v"
                        ? "\v"
                        : escaped === "0"
                          ? "\0"
                          : escaped;
          offset++;
          continue;
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
    const operator = operatorsByFirstChar.get(char)?.find((candidate) => source.startsWith(candidate, offset));
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
      const conditional: ExpressionNode = {
        type: "conditional",
        test: left.value,
        consequent: consequent.value,
        alternate: alternate.value,
      };
      left = ok(conditional);
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

const parseNativeExpression = (source: string): Result<ExpressionNode, CompilerError> => {
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

const literalPropertyName = (node: ExpressionNode): string | undefined =>
  node.type === "literal" && typeof node.value === "string" ? node.value : undefined;

const denyForbiddenPropertyName = (name: string): Result<void, CompilerError> =>
  deniedPropertyNames.has(name) ? expressionError(`Disallowed expression property: ${name}.`) : ok(undefined);

const isDeniedPropertyKey = (key: unknown): boolean => deniedPropertyNames.has(String(key));

const validateExpressionNode = (node: ExpressionNode): Result<ExpressionNode, CompilerError> => {
  if (node.type === "identifier") {
    for (const part of node.path) {
      const denied = denyForbiddenPropertyName(part);
      if (!denied.ok) {
        return denied;
      }
    }
    return ok(node);
  }
  if (node.type === "literal" || node.type === "regex") {
    return ok(node);
  }
  if (node.type === "array") {
    for (const item of node.items) {
      const valid = validateExpressionNode(item);
      if (!valid.ok) {
        return valid;
      }
    }
    return ok(node);
  }
  if (node.type === "object") {
    for (const entry of node.entries) {
      const denied = denyForbiddenPropertyName(entry.key);
      if (!denied.ok) {
        return denied;
      }
      const valid = validateExpressionNode(entry.value);
      if (!valid.ok) {
        return valid;
      }
    }
    return ok(node);
  }
  if (node.type === "unary") {
    const valid = validateExpressionNode(node.argument);
    return valid.ok ? ok(node) : valid;
  }
  if (node.type === "conditional") {
    const test = validateExpressionNode(node.test);
    if (!test.ok) return test;
    const consequent = validateExpressionNode(node.consequent);
    if (!consequent.ok) return consequent;
    const alternate = validateExpressionNode(node.alternate);
    return alternate.ok ? ok(node) : alternate;
  }
  if (node.type === "call") {
    const callee = validateExpressionNode(node.callee);
    if (!callee.ok) {
      return callee;
    }
    for (const arg of node.args) {
      const valid = validateExpressionNode(arg);
      if (!valid.ok) {
        return valid;
      }
    }
    return ok(node);
  }
  if (node.type === "member") {
    const propertyName = literalPropertyName(node.property);
    if (propertyName) {
      const denied = denyForbiddenPropertyName(propertyName);
      if (!denied.ok) {
        return denied;
      }
    }
    const object = validateExpressionNode(node.object);
    if (!object.ok) {
      return object;
    }
    const property = validateExpressionNode(node.property);
    return property.ok ? ok(node) : property;
  }
  if (node.type === "template") {
    for (const part of node.parts) {
      if (typeof part === "string") {
        continue;
      }
      const valid = validateExpressionNode(part);
      if (!valid.ok) {
        return valid;
      }
    }
    return ok(node);
  }
  const left = validateExpressionNode(node.left);
  if (!left.ok) {
    return left;
  }
  const right = validateExpressionNode(node.right);
  return right.ok ? ok(node) : right;
};

const validateParsedExpression = (
  result: Result<ExpressionNode, CompilerError>,
): Result<ExpressionNode, CompilerError> => (result.ok ? validateExpressionNode(result.value) : result);

const maybeIdentifierPath = (
  object: ExpressionNode,
  property: ExpressionNode,
  computed: boolean,
  optional: boolean,
): ExpressionNode => {
  const propertyName = literalPropertyName(property);
  if (!computed && !optional && object.type === "identifier" && propertyName) {
    return { type: "identifier", path: [...object.path, propertyName] };
  }
  return { type: "member", object, property, computed, optional };
};

const oxcError = (message: string): Result<never, CompilerError> => expressionError(message);

type OxcParserModule = {
  parseSync: (filename: string, sourceText: string, options?: ParserOptions | undefined | null) => ParseResult;
};

type NodeProcessWithBuiltinModule = {
  process?: {
    getBuiltinModule?: (name: string) => unknown;
  };
};

type CreateRequireModule = {
  createRequire?: (filename: string) => (specifier: string) => unknown;
};

let cachedOxcParser: OxcParserModule | undefined;

const loadOxcParser = (): OxcParserModule | undefined => {
  if (cachedOxcParser) {
    return cachedOxcParser;
  }
  const moduleApi = (globalThis as NodeProcessWithBuiltinModule).process?.getBuiltinModule?.("module") as
    | CreateRequireModule
    | undefined;
  const require = moduleApi?.createRequire?.(import.meta.url);
  let loaded: OxcParserModule | undefined;
  try {
    loaded = require?.("oxc-parser") as OxcParserModule | undefined;
  } catch {
    return undefined;
  }
  if (loaded?.parseSync) {
    cachedOxcParser = loaded;
  }
  return cachedOxcParser;
};

const oxcExpressionToNode = (node: OxcExpression): Result<ExpressionNode, CompilerError> => {
  if (node.type === "Literal") {
    const regex = "regex" in node ? node.regex : undefined;
    if (regex) {
      return ok({ type: "regex", pattern: regex.pattern, flags: regex.flags });
    }
    if (
      typeof node.value === "string" ||
      typeof node.value === "number" ||
      typeof node.value === "boolean" ||
      node.value === null
    ) {
      return ok({ type: "literal", value: node.value });
    }
    return oxcError("Unsupported literal expression.");
  }
  if (node.type === "Identifier") {
    return ok({ type: "identifier", path: [node.name] });
  }
  if (node.type === "ArrayExpression") {
    const items: ExpressionNode[] = [];
    for (const item of node.elements) {
      if (!item || item.type === "SpreadElement") {
        return oxcError("Unsupported array expression.");
      }
      const parsed = oxcExpressionToNode(item);
      if (!parsed.ok) {
        return parsed;
      }
      items.push(parsed.value);
    }
    return ok({ type: "array", items });
  }
  if (node.type === "ObjectExpression") {
    const entries: Array<{ key: string; value: ExpressionNode }> = [];
    for (const property of node.properties) {
      if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed) {
        return oxcError("Unsupported object property expression.");
      }
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "Literal" &&
              (typeof property.key.value === "string" || typeof property.key.value === "number")
            ? String(property.key.value)
            : undefined;
      if (!key) {
        return oxcError("Unsupported object key expression.");
      }
      const value = oxcExpressionToNode(property.value);
      if (!value.ok) {
        return value;
      }
      entries.push({ key, value: value.value });
    }
    return ok({ type: "object", entries });
  }
  if (node.type === "UnaryExpression") {
    if (node.operator !== "!" && node.operator !== "-") {
      return oxcError(`Unsupported unary operator: ${node.operator}.`);
    }
    const argument = oxcExpressionToNode(node.argument);
    return argument.ok ? ok({ type: "unary", operator: node.operator, argument: argument.value }) : argument;
  }
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    if (node.left.type === "PrivateIdentifier") {
      return oxcError("Unsupported private identifier expression.");
    }
    const left = oxcExpressionToNode(node.left);
    if (!left.ok) {
      return left;
    }
    const right = oxcExpressionToNode(node.right);
    if (!right.ok) {
      return right;
    }
    return ok({ type: "binary", operator: node.operator, left: left.value, right: right.value });
  }
  if (node.type === "ConditionalExpression") {
    const test = oxcExpressionToNode(node.test);
    const consequent = oxcExpressionToNode(node.consequent);
    const alternate = oxcExpressionToNode(node.alternate);
    if (!test.ok) return test;
    if (!consequent.ok) return consequent;
    if (!alternate.ok) return alternate;
    return ok({ type: "conditional", test: test.value, consequent: consequent.value, alternate: alternate.value });
  }
  if (node.type === "CallExpression") {
    const callee = oxcExpressionToNode(node.callee);
    if (!callee.ok) {
      return callee;
    }
    const args: ExpressionNode[] = [];
    for (const argument of node.arguments) {
      if (argument.type === "SpreadElement") {
        return oxcError("Unsupported spread call argument.");
      }
      const parsed = oxcExpressionToNode(argument);
      if (!parsed.ok) {
        return parsed;
      }
      args.push(parsed.value);
    }
    return ok({ type: "call", callee: callee.value, args });
  }
  if (node.type === "ChainExpression") {
    return oxcExpressionToNode(node.expression);
  }
  if (node.type === "MemberExpression") {
    const object = oxcExpressionToNode(node.object);
    if (!object.ok) {
      return object;
    }
    const property = node.computed
      ? oxcExpressionToNode(node.property)
      : node.property.type === "Identifier"
        ? ok<ExpressionNode>({ type: "literal", value: node.property.name })
        : oxcError("Unsupported private member expression.");
    return property.ok ? ok(maybeIdentifierPath(object.value, property.value, node.computed, node.optional)) : property;
  }
  if (node.type === "TemplateLiteral") {
    const parts: Array<string | ExpressionNode> = [];
    for (const [index, quasi] of node.quasis.entries()) {
      parts.push(quasi.value.cooked ?? quasi.value.raw);
      const expression = node.expressions[index];
      if (!expression) {
        continue;
      }
      const parsed = oxcExpressionToNode(expression);
      if (!parsed.ok) {
        return parsed;
      }
      parts.push(parsed.value);
    }
    return ok({ type: "template", parts });
  }
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSInstantiationExpression"
  ) {
    return oxcExpressionToNode(node.expression);
  }
  return oxcError(`Unsupported expression syntax: ${node.type}.`);
};

const parseOxcExpression = (source: string): Result<ExpressionNode, CompilerError> => {
  const parser = loadOxcParser();
  if (!parser) {
    return expressionError(
      'Tachyon expression compilation requires the optional peer dependency "oxc-parser". Install it with "pnpm add oxc-parser".',
    );
  }
  const wrapped = `const __tachyon_expr = (${source});`;
  try {
    const result = parser.parseSync("tachyon-expression.ts", wrapped, {
      astType: "js",
      lang: "ts",
      preserveParens: false,
      sourceType: "module",
    });
    const [error] = result.errors;
    if (error) {
      return expressionError(error.message);
    }
    const declaration = result.program.body[0];
    const init = declaration?.type === "VariableDeclaration" ? declaration.declarations[0]?.init : undefined;
    return init ? oxcExpressionToNode(init) : expressionError("Unable to read OXC expression.");
  } catch (error) {
    return expressionError(error instanceof Error ? error.message : "Unable to parse expression with OXC.");
  }
};

export const parseExpression = (
  source: string,
  options: ExpressionParseOptions = {},
): Result<ExpressionNode, CompilerError> => {
  const backend = options.backend ?? "auto";
  const key = cacheKeyFor(source, backend);
  const cached = expressionCache.get(key);
  if (cached) {
    expressionCache.delete(key);
    expressionCache.set(key, cached);
    return cached;
  }
  if (backend === "oxc") {
    return rememberExpression(key, validateParsedExpression(parseOxcExpression(source)));
  }
  const native = parseNativeExpression(source);
  if (backend === "native" || native.ok) {
    return rememberExpression(key, validateParsedExpression(native));
  }
  return rememberExpression(key, validateParsedExpression(parseOxcExpression(source)));
};

const readPath = (scope: Record<string, unknown>, path: readonly string[]): unknown => {
  let current: unknown = scope;
  for (let index = 0; index < path.length; index++) {
    const part = path[index] as string;
    if (isDeniedPropertyKey(part)) {
      return undefined;
    }
    if (current == null || typeof current !== "object") {
      throw new TypeError(`Cannot read properties of ${current}.`);
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
  if (node.type === "regex") {
    return new RegExp(node.pattern, node.flags);
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
    if (node.callee.type === "identifier" && node.callee.path.length > 1) {
      const object = readPath(scope, node.callee.path.slice(0, -1));
      const property = node.callee.path.at(-1) as string;
      if (isDeniedPropertyKey(property)) {
        return undefined;
      }
      const callee = (Object(object) as Record<PropertyKey, unknown>)[property];
      if (typeof callee !== "function") {
        return undefined;
      }
      return callee.apply(
        object,
        node.args.map((arg) => evaluateExpressionNode(arg, scope)),
      );
    }
    if (node.callee.type === "member") {
      const object = evaluateExpressionNode(node.callee.object, scope);
      if (node.callee.optional && object == null) return undefined;
      const property = evaluateExpressionNode(node.callee.property, scope);
      if (isDeniedPropertyKey(property)) {
        return undefined;
      }
      if (object == null) {
        if (node.callee.optional) {
          return undefined;
        }
        throw new TypeError(`Cannot read properties of ${object}.`);
      }
      const callee = (object as Record<PropertyKey, unknown>)[property as PropertyKey];
      if (typeof callee !== "function") {
        return undefined;
      }
      return callee.apply(
        object,
        node.args.map((arg) => evaluateExpressionNode(arg, scope)),
      );
    }
    const callee = evaluateExpressionNode(node.callee, scope);
    if (typeof callee !== "function") {
      return undefined;
    }
    return callee(...node.args.map((arg) => evaluateExpressionNode(arg, scope)));
  }
  if (node.type === "member") {
    const object = evaluateExpressionNode(node.object, scope);
    if (node.optional && object == null) return undefined;
    const property = evaluateExpressionNode(node.property, scope);
    if (isDeniedPropertyKey(property)) {
      return undefined;
    }
    if (object == null) {
      if (node.optional) {
        return undefined;
      }
      throw new TypeError(`Cannot read properties of ${object}.`);
    }
    return (object as Record<PropertyKey, unknown>)[property as PropertyKey];
  }
  if (node.type === "template") {
    return node.parts
      .map((part) => (typeof part === "string" ? part : String(evaluateExpressionNode(part, scope))))
      .join("");
  }
  const left = evaluateExpressionNode(node.left, scope);
  if (node.operator === "??") {
    return left ?? evaluateExpressionNode(node.right, scope);
  }
  if (node.operator === "&&") {
    return left && evaluateExpressionNode(node.right, scope);
  }
  if (node.operator === "||") {
    return left || evaluateExpressionNode(node.right, scope);
  }
  const right = evaluateExpressionNode(node.right, scope);
  if (node.operator === "===") return left === right;
  if (node.operator === "!==") return left !== right;
  if (node.operator === "==") return left == right;
  if (node.operator === "!=") return left != right;
  if (node.operator === "+") {
    return (left as any) + (right as any);
  }
  if (node.operator === "-") return Number(left) - Number(right);
  if (node.operator === "*") return Number(left) * Number(right);
  if (node.operator === "/") return Number(left) / Number(right);
  if (node.operator === "%") return Number(left) % Number(right);
  const comparableLeft = left as number;
  const comparableRight = right as number;
  if (node.operator === ">") return comparableLeft > comparableRight;
  if (node.operator === "<") return comparableLeft < comparableRight;
  if (node.operator === ">=") return comparableLeft >= comparableRight;
  if (node.operator === "<=") return comparableLeft <= comparableRight;
  return undefined;
};

export const evaluateExpression = (source: string, scope: Record<string, unknown>): unknown => {
  const parsed = parseExpression(source);
  return parsed.ok ? evaluateExpressionNode(parsed.value, scope) : undefined;
};

export const expressionToJs = (
  source: string,
  locals: ReadonlySet<string> = new Set(),
  scopeName = "scope",
  options: ExpressionParseOptions = {},
  aliases: ExpressionAliases = new Map(),
): string => {
  const parsed = parseExpression(source, options);
  return parsed.ok ? expressionNodeToJs(parsed.value, locals, scopeName, aliases) : "undefined";
};

const memberObjectToJs = (
  node: ExpressionNode,
  locals: ReadonlySet<string>,
  scopeName: string,
  aliases: ExpressionAliases,
): string => {
  const expression = expressionNodeToJs(node, locals, scopeName, aliases);
  return node.type === "identifier" || node.type === "member" || node.type === "call" ? expression : `(${expression})`;
};

const isIdentifierName = (value: string): boolean => /^[A-Za-z_$][\w$]*$/.test(value);

const deniedPropertyCheckToJs = (propertyName: string): string =>
  deniedPropertyNameList.map((name) => `String(${propertyName}) === ${JSON.stringify(name)}`).join(" || ");

const guardedMemberAccessToJs = (object: string, property: string, optional: boolean): string =>
  optional
    ? `((__tachyonObject, __tachyonKey) => __tachyonObject == null ? undefined : ((__tachyonProperty) => ${deniedPropertyCheckToJs("__tachyonProperty")} ? undefined : __tachyonObject[__tachyonProperty])(__tachyonKey()))(${object}, () => (${property}))`
    : `((__tachyonObject, __tachyonProperty) => ${optional ? "__tachyonObject == null ? undefined : " : ""}${deniedPropertyCheckToJs(
        "__tachyonProperty",
      )} ? undefined : __tachyonObject[__tachyonProperty])(${object}, ${property})`;

const guardedMemberCallToJs = (
  object: string,
  property: string,
  args: readonly string[],
  optional: boolean,
): string => {
  if (optional) {
    return `((__tachyonObject, __tachyonKey, __tachyonArgs) => { if (__tachyonObject == null) return undefined; const __tachyonProperty = __tachyonKey(); if (${deniedPropertyCheckToJs("__tachyonProperty")}) return undefined; const __tachyonCallee = __tachyonObject[__tachyonProperty]; return typeof __tachyonCallee === "function" ? __tachyonCallee.apply(__tachyonObject, __tachyonArgs()) : undefined; })(${object}, () => (${property}), () => [${args.join(", ")}])`;
  }
  const argsArray = `[${args.join(", ")}]`;
  return `((__tachyonObject, __tachyonProperty) => { if (${
    optional ? "__tachyonObject == null || " : ""
  }${deniedPropertyCheckToJs(
    "__tachyonProperty",
  )}) return undefined; const __tachyonCallee = __tachyonObject[__tachyonProperty]; return typeof __tachyonCallee === "function" ? __tachyonCallee.apply(__tachyonObject, ${argsArray}) : undefined; })(${object}, ${property})`;
};

const genericCallToJs = (callee: string, args: readonly string[]): string =>
  `((__tachyonCallee) => typeof __tachyonCallee === "function" ? __tachyonCallee(${args.join(
    ", ",
  )}) : undefined)(${callee})`;

export const expressionNodeToJs = (
  node: ExpressionNode,
  locals: ReadonlySet<string> = new Set(),
  scopeName = "scope",
  aliases: ExpressionAliases = new Map(),
): string => {
  if (node.type === "identifier") {
    const [head, ...tail] = node.path;
    const alias = head ? aliases.get(head) : undefined;
    const root =
      head && locals.has(head)
        ? head
        : alias && alias !== head
          ? `${scopeName}[${JSON.stringify(alias)}]`
          : `${scopeName}.${head ?? ""}`;
    return [root, ...tail].join(".");
  }
  if (node.type === "literal") {
    return JSON.stringify(node.value);
  }
  if (node.type === "regex") {
    return `new RegExp(${JSON.stringify(node.pattern)}, ${JSON.stringify(node.flags)})`;
  }
  if (node.type === "array") {
    return `[${node.items.map((item) => expressionNodeToJs(item, locals, scopeName, aliases)).join(", ")}]`;
  }
  if (node.type === "object") {
    return `{ ${node.entries
      .map((entry) => `${JSON.stringify(entry.key)}: ${expressionNodeToJs(entry.value, locals, scopeName, aliases)}`)
      .join(", ")} }`;
  }
  if (node.type === "unary") {
    return `(${node.operator}${expressionNodeToJs(node.argument, locals, scopeName, aliases)})`;
  }
  if (node.type === "conditional") {
    return `(${expressionNodeToJs(node.test, locals, scopeName, aliases)} ? ${expressionNodeToJs(
      node.consequent,
      locals,
      scopeName,
      aliases,
    )} : ${expressionNodeToJs(node.alternate, locals, scopeName, aliases)})`;
  }
  if (node.type === "call") {
    const args = node.args.map((arg) => expressionNodeToJs(arg, locals, scopeName, aliases));
    if (node.callee.type === "member") {
      const object = memberObjectToJs(node.callee.object, locals, scopeName, aliases);
      const propertyName = literalPropertyName(node.callee.property);
      if (!node.callee.computed && propertyName && isIdentifierName(propertyName)) {
        return `${object}${node.callee.optional ? "?." : "."}${propertyName}(${args.join(", ")})`;
      }
      const property = expressionNodeToJs(node.callee.property, locals, scopeName, aliases);
      return guardedMemberCallToJs(object, property, args, node.callee.optional);
    }
    if (node.callee.type === "identifier") {
      return `${expressionNodeToJs(node.callee, locals, scopeName, aliases)}(${args.join(", ")})`;
    }
    return genericCallToJs(expressionNodeToJs(node.callee, locals, scopeName, aliases), args);
  }
  if (node.type === "member") {
    const object = memberObjectToJs(node.object, locals, scopeName, aliases);
    const propertyName = literalPropertyName(node.property);
    if (!node.computed && propertyName && isIdentifierName(propertyName)) {
      return `${object}${node.optional ? "?." : "."}${propertyName}`;
    }
    const property = expressionNodeToJs(node.property, locals, scopeName, aliases);
    return guardedMemberAccessToJs(object, property, node.optional);
  }
  if (node.type === "template") {
    return node.parts
      .map((part) =>
        typeof part === "string"
          ? JSON.stringify(part)
          : `String(${expressionNodeToJs(part, locals, scopeName, aliases)})`,
      )
      .join(" + ");
  }
  return `(${expressionNodeToJs(node.left, locals, scopeName, aliases)} ${node.operator} ${expressionNodeToJs(
    node.right,
    locals,
    scopeName,
    aliases,
  )})`;
};

const isAssignableNode = (node: ExpressionNode): boolean => {
  if (node.type === "identifier") {
    return true;
  }
  if (node.type === "member") {
    return !node.optional && isAssignableNode(node.object);
  }
  return false;
};

export const isAssignableExpression = (source: string, options: ExpressionParseOptions = {}): boolean => {
  const parsed = parseExpression(source, options);
  return parsed.ok && isAssignableNode(parsed.value);
};
