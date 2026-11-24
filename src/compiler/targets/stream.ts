import { ok, type Result } from "../../result.js";
import type { CompiledTemplate, CompilerError, ElementNode, TemplateNode, TextNode } from "../types.js";
import { generatedEscapeHtmlHelperLines } from "../../html-escape.js";
import {
  componentEndMarker,
  componentStartMarker,
  conditionalEndMarker,
  conditionalStartMarker,
  listEndMarker,
  listStartMarker,
  outletEndMarker,
  outletStartMarker,
  slotEndMarker,
  slotStartMarker,
} from "../../conditional-marker.js";
import { emptyTextMarker } from "../../text-marker.js";
import { generatedUrlAttributeHelperLines } from "../url-policy-codegen.js";
import { componentCallPropsFor } from "../ir.js";
import {
  attrExpression,
  attrString,
  assertSafeIdentifierName,
  childPathEntries,
  expressionToScopeAccess,
  hydrationBoundaryFor,
  isComponentCallTagName,
  isVoidElement,
  itemNameFromKey,
  jsOptionalPropertyAccess,
  jsString,
  readExpressionAttribute,
  renderableChildren,
  textExpressionSegments,
} from "../utils.js";
import { hasDynamicUrlAttribute, renderOpenTagExpression } from "./server.js";

const renderTextYieldStatements = (node: TextNode, locals: ReadonlySet<string>, indent: string): string[] => {
  const statements: string[] = [];
  let lastEmittedWasText = false;
  const separateTextNode = (): void => {
    if (lastEmittedWasText) {
      statements.push(`${indent}yield "<!---->";`);
    }
  };
  for (const segment of textExpressionSegments(node.value)) {
    if (segment.kind === "text") {
      if (segment.value) {
        separateTextNode();
        statements.push(`${indent}yield ${jsString(segment.value)};`);
        lastEmittedWasText = true;
      }
      continue;
    }
    separateTextNode();
    statements.push(
      `${indent}yield (escapeHtml(${expressionToScopeAccess(segment.value, locals)}) || ${jsString(emptyTextMarker)});`,
    );
    lastEmittedWasText = true;
  }
  return statements;
};

type StreamEmitContext = {
  awaitCounter: { next: number };
};

const renderChildYieldStatements = (
  children: readonly TemplateNode[],
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
  ctx: StreamEmitContext,
): string[] =>
  childPathEntries(children, path).flatMap((entry) =>
    renderNodeYieldStatements(entry.child, locals, indent, entry.path, ctx),
  );

const renderForYieldStatements = (
  node: ElementNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
  ctx: StreamEmitContext,
): string[] => {
  const each = attrExpression(node, "each") ?? "[]";
  const key = attrExpression(node, "key") ?? "item";
  const itemName = attrString(node, "as")?.trim() || itemNameFromKey(key);
  const indexName = attrString(node, "index")?.trim();
  const eachAccess = expressionToScopeAccess(each, locals);
  const childLocals = new Set(locals);
  childLocals.add(itemName);
  if (indexName) childLocals.add(indexName);
  const statements = [
    `${indent}yield ${jsString(listStartMarker)};`,
    `${indent}if (Array.isArray(${eachAccess})) {`,
    indexName
      ? `${indent}  for (const [${indexName}, ${itemName}] of ${eachAccess}.entries()) {`
      : `${indent}  for (const ${itemName} of ${eachAccess}) {`,
  ];
  statements.push(...renderChildYieldStatements(node.children, childLocals, `${indent}    `, path, ctx));
  statements.push(`${indent}  }`, `${indent}}`, `${indent}yield ${jsString(listEndMarker)};`);
  return statements;
};

const renderAwaitYieldStatements = (
  node: ElementNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
  ctx: StreamEmitContext,
): string[] => {
  const id = `a${ctx.awaitCounter.next++}`;
  const startMarker = `<!--tachyon-await:${id}-->`;
  const endMarker = `<!--/tachyon-await:${id}-->`;
  const thenName = attrString(node, "then") ?? "value";
  const pending = attrString(node, "pending") ?? attrString(node, "fallback");
  const errorText = attrString(node, "error");
  const reorder = attrString(node, "reorder") === "resolve" ? "resolve" : "preserve";
  const valueExpr = expressionToScopeAccess(attrExpression(node, "value") ?? "undefined", locals);
  const childLocals = new Set(locals);
  childLocals.add(thenName);
  const bodyStatements = renderChildYieldStatements(node.children, childLocals, `${indent}      `, path, ctx);
  const usesDeferredReplacement = pending !== undefined || reorder === "resolve";

  if (!usesDeferredReplacement) {
    // Inline awaiting when neither pending placeholder nor resolve-order streaming is requested:
    // preserves zero-script streaming while still emitting region markers for hydration.
    const statements = [
      `${indent}{`,
      `${indent}  yield ${jsString(startMarker)};`,
    ];
    if (errorText !== undefined) {
      statements.push(`${indent}  try {`);
      statements.push(`${indent}    const ${thenName} = await ${valueExpr};`);
      statements.push(...bodyStatements);
      statements.push(`${indent}  } catch {`);
      statements.push(`${indent}    yield ${jsString(`<!--td:await:error-->${errorText}`)};`);
      statements.push(`${indent}  }`);
    } else {
      statements.push(`${indent}  const ${thenName} = await ${valueExpr};`);
      statements.push(...bodyStatements);
    }
    statements.push(`${indent}  yield ${jsString(endMarker)};`);
    statements.push(`${indent}}`);
    return statements;
  }

  // Deferred replacement streaming: flush placeholder immediately without blocking shell HTML,
  // then stream `<template>` + `<script>` replacement chunks after the shell finishes.
  const collectedBody = bodyStatements.map((line) => {
    const yieldMatch = /^(\s*)yield (.*);$/.exec(line);
    if (yieldMatch) return `${yieldMatch[1]}__out += String(${yieldMatch[2]} ?? "");`;
    const yieldStarMatch = /^(\s*)yield\* (.*);$/.exec(line);
    if (yieldStarMatch) return `${yieldStarMatch[1]}for await (const __c of ${yieldStarMatch[2]}) __out += String(__c ?? "");`;
    return line;
  });

  const valVar = `__tachyonAwaitVal_${id}`;
  const statements = [
    `${indent}{`,
    `${indent}  const ${valVar} = ${valueExpr};`,
    `${indent}  if (!__tachyonIsThenable(${valVar})) {`,
    `${indent}    const ${thenName} = ${valVar};`,
    `${indent}    yield ${jsString(startMarker)};`,
    ...bodyStatements,
    `${indent}    yield ${jsString(endMarker)};`,
    `${indent}  } else {`,
    `${indent}    yield ${jsString(`${startMarker}<!--td:await:pending-->${pending ?? ""}${endMarker}`)};`,
    `${indent}    __tachyonPendingAwaits.push({`,
    `${indent}      id: ${jsString(id)},`,
    `${indent}      reorder: ${jsString(reorder)},`,
    `${indent}      task: Promise.resolve(${valVar}).then(`,
    `${indent}        async (${thenName}) => {`,
    `${indent}          let __out = "";`,
    ...collectedBody,
    `${indent}          return { id: ${jsString(id)}, status: "resolved", html: __out };`,
    `${indent}        },`,
    errorText !== undefined
      ? `${indent}        () => ({ id: ${jsString(id)}, status: "error", html: ${jsString(`<!--td:await:error-->${errorText}`)} }),`
      : `${indent}        (error) => ({ id: ${jsString(id)}, status: "throw", error }),`,
    `${indent}      ),`,
    `${indent}    });`,
    `${indent}  }`,
    `${indent}}`,
  ];
  return statements;
};

const renderElementYieldStatements = (
  node: ElementNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
  ctx: StreamEmitContext,
): string[] => {
  if (node.tagName === "outlet") {
    return [
      `${indent}yield ${JSON.stringify(outletStartMarker)};`,
      `${indent}yield String(scope.outlet ?? "");`,
      `${indent}yield ${JSON.stringify(outletEndMarker)};`,
    ];
  }
  if (node.tagName === "slot") {
    const name = attrString(node, "name") ?? "default";
    return [
      `${indent}yield ${JSON.stringify(slotStartMarker(name))};`,
      `${indent}yield String(${jsOptionalPropertyAccess("scope.slots", name)} ?? "");`,
      `${indent}yield ${JSON.stringify(slotEndMarker(name))};`,
    ];
  }
  if (node.tagName === "for") {
    return renderForYieldStatements(node, locals, indent, path, ctx);
  }
  if (node.tagName === "if") {
    const statements = [
      `${indent}yield ${jsString(conditionalStartMarker)};`,
      `${indent}if (${expressionToScopeAccess(attrExpression(node, "test") ?? "false", locals)}) {`,
    ];
    statements.push(...renderChildYieldStatements(node.children, locals, `${indent}  `, path, ctx));
    statements.push(`${indent}}`, `${indent}yield ${jsString(conditionalEndMarker)};`);
    return statements;
  }
  if (node.tagName === "store") {
    return [];
  }
  if (node.tagName === "component") {
    return renderComponentYieldStatements(node, locals, indent, path, ctx);
  }
  if (isComponentCallTagName(node.tagName)) {
    const targetExpr = expressionToScopeAccess(node.tagName, locals);
    const propEntries = componentCallPropsFor(node).map((prop) => {
      const valueExpr =
        prop.kind === "boolean"
          ? "true"
          : prop.kind === "static"
            ? jsString(prop.value as string)
            : expressionToScopeAccess(prop.value as string, locals);
      return `${JSON.stringify(prop.name)}: ${valueExpr}`;
    });
    return [
      `${indent}yield ${jsString(componentStartMarker)};`,
      `${indent}yield* __tachyonStreamComponent(${targetExpr}, { ${propEntries.join(", ")} }, ${jsString(node.tagName)}, __tachyonStreamOptions);`,
      `${indent}yield ${jsString(componentEndMarker)};`,
    ];
  }
  if (node.tagName === "await") {
    return renderAwaitYieldStatements(node, locals, indent, path, ctx);
  }
  const hydrateBoundary = hydrationBoundaryFor(node, path);
  const statements: string[] = [];
  if (hydrateBoundary) {
    const marker =
      hydrateBoundary.idKind === "static"
        ? jsString(hydrateBoundary.id)
        : expressionToScopeAccess(hydrateBoundary.id, locals);
    statements.push(
      `${indent}yield ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":start-->")};`,
    );
  }
  statements.push(`${indent}yield ${renderOpenTagExpression(node, locals)};`);
  statements.push(...renderChildYieldStatements(node.children, locals, indent, path, ctx));
  if (!isVoidElement(node)) {
    statements.push(`${indent}yield ${jsString(`</${node.tagName}>`)};`);
  }
  if (hydrateBoundary) {
    const marker =
      hydrateBoundary.idKind === "static"
        ? jsString(hydrateBoundary.id)
        : expressionToScopeAccess(hydrateBoundary.id, locals);
    statements.push(
      `${indent}yield ${jsString("<!--tachyon-hydrate:")} + escapeMarker(${marker}) + ${jsString(":end-->")};`,
    );
  }
  return statements;
};

const renderComponentYieldStatements = (
  node: ElementNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[],
  ctx: StreamEmitContext,
): string[] => {
  const localNames = new Set(locals);
  const statements = [`${indent}{`];
  for (const attr of node.attrs) {
    if (attr.name === "name") {
      continue;
    }
    const expression = readExpressionAttribute(attr.value);
    if (expression) {
      statements.push(`${indent}  const ${attr.name} = ${expressionToScopeAccess(expression, localNames)};`);
      localNames.add(attr.name);
    }
  }
  for (const child of node.children) {
    if (child.type !== "element" || child.tagName !== "store") {
      continue;
    }
    for (const attr of child.attrs) {
      const initial = readExpressionAttribute(attr.value);
      if (initial) {
        statements.push(`${indent}  const ${attr.name} = ${expressionToScopeAccess(initial, localNames)};`);
        localNames.add(attr.name);
      }
    }
  }
  const children = renderableChildren(node);
  if (children.length === 1) {
    statements.push(...renderNodeYieldStatements(children[0] as TemplateNode, localNames, `${indent}  `, path, ctx));
  } else {
    statements.push(...renderChildYieldStatements(children, localNames, `${indent}  `, path, ctx));
  }
  statements.push(`${indent}}`);
  return statements;
};

const renderNodeYieldStatements = (
  node: TemplateNode,
  locals: ReadonlySet<string>,
  indent: string,
  path: number[] = [],
  ctx: StreamEmitContext = { awaitCounter: { next: 0 } },
): string[] => {
  if (node.type === "text") {
    return renderTextYieldStatements(node, locals, indent);
  }
  return renderElementYieldStatements(node, locals, indent, path, ctx);
};

export type ServerStreamModuleOptions = {
  defaultScopeName?: string;
};

export const validateServerStreamTemplate = (_template: CompiledTemplate): Result<void, CompilerError> =>
  ok(undefined);

const hasComponentCallNode = (node: TemplateNode): boolean =>
  node.type === "element" && (isComponentCallTagName(node.tagName) || node.children.some(hasComponentCallNode));

const hasDeferredAwaitNode = (node: TemplateNode): boolean =>
  node.type === "element" &&
  ((node.tagName === "await" &&
    (attrString(node, "pending") !== undefined ||
      attrString(node, "fallback") !== undefined ||
      attrString(node, "reorder") === "resolve")) ||
    node.children.some(hasDeferredAwaitNode));

const generatedStreamComponentHelperLines = [
  `const __tachyonStreamComponent = async function* (target, props, name, options) {`,
  `  if (target && typeof target.stream === "function") { yield* target.stream(props, options); return; }`,
  `  if (target && typeof target.render === "function") { yield String(target.render(props)); return; }`,
  `  throw new TypeError("Component call <" + name + "> does not provide a stream or render method.");`,
  `};`,
];

const awaitBootstrapScriptBody =
  `window.__tachyonAwaitSwap||(window.__tachyonAwaitSwap=function(id,st){` +
  `var d=document,t=d.querySelector('template[data-tachyon-await="'+id+'"]');if(!t)return;` +
  `var s="tachyon-await:"+id,e="/"+s,w=d.createTreeWalker(d,128),n,a,b;` +
  `while((n=w.nextNode())){if(n.nodeValue===s){var nx=n.nextSibling;if(nx&&nx.nodeType===8&&nx.nodeValue==="td:await:pending"){a=n;break;}if(!a)a=n;}}` +
  `if(a){for(n=a.nextSibling;n;n=n.nextSibling){if(n.nodeType===8&&n.nodeValue===e){b=n;break;}}}` +
  `if(a&&b&&a.parentNode===b.parentNode){while(a.nextSibling&&a.nextSibling!==b)a.nextSibling.remove();b.parentNode.insertBefore(t.content,b);}` +
  `t.remove();var sc=d.querySelector('script[data-tachyon-await="swap:'+id+'"]');if(sc)sc.remove();` +
  `var h=window.__tachyonAwaitHandlers,fn=h&&h.get(id);if(fn){h.delete(id);fn(st);}});`;

const generatedDeferredAwaitHelperLines = [
  `const __tachyonIsThenable = (value) => (typeof value === "object" || typeof value === "function") && value !== null && typeof value.then === "function";`,
  `const __tachyonFormatNonce = (options) => {`,
  `  const nonce = options && typeof options === "object" ? options.nonce : undefined;`,
  `  if (nonce === undefined || nonce === "") return "";`,
  `  if (typeof nonce !== "string" || /[\\s"'<>\\\\\\u0000-\\u001f\\u007f]/.test(nonce)) throw new TypeError("Invalid CSP nonce for <await> stream script.");`,
  `  return ' nonce="' + nonce + '"';`,
  `};`,
  `const __tachyonAwaitBootstrap = (nonceAttr) => '<script data-tachyon-await="bootstrap"' + nonceAttr + '>' + ${jsString(awaitBootstrapScriptBody)} + '</script>';`,
  `const __tachyonAwaitSwapChunk = (entry, nonceAttr) => '<template data-tachyon-await="' + entry.id + '" data-status="' + entry.status + '">' + entry.html + '</template><script data-tachyon-await="swap:' + entry.id + '"' + nonceAttr + '>__tachyonAwaitSwap(' + JSON.stringify(entry.id) + ',' + JSON.stringify(entry.status) + ')</script>';`,
  `const __tachyonDrainPendingAwaits = async function* (pending, nonceAttr) {`,
  `  if (pending.length === 0) return;`,
  `  yield __tachyonAwaitBootstrap(nonceAttr);`,
  `  const resolveQueue = pending.filter((entry) => entry.reorder === "resolve");`,
  `  const preserveQueue = pending.filter((entry) => entry.reorder !== "resolve");`,
  `  if (resolveQueue.length > 0) {`,
  `    const inFlight = new Map(resolveQueue.map((entry, idx) => [idx, entry.task.then((res) => ({ idx, res }))]));`,
  `    while (inFlight.size > 0) {`,
  `      const { idx, res } = await Promise.race(inFlight.values());`,
  `      inFlight.delete(idx);`,
  `      if (res.status === "throw") throw res.error;`,
  `      yield __tachyonAwaitSwapChunk(res, nonceAttr);`,
  `    }`,
  `  }`,
  `  for (const entry of preserveQueue) {`,
  `    const res = await entry.task;`,
  `    if (res.status === "throw") throw res.error;`,
  `    yield __tachyonAwaitSwapChunk(res, nonceAttr);`,
  `  }`,
  `};`,
];

const streamModuleCache = new WeakMap<CompiledTemplate, Map<string, string>>();

export const generateServerStreamModule = (
  template: CompiledTemplate,
  options: ServerStreamModuleOptions = {},
): string => {
  if (options.defaultScopeName !== undefined) {
    assertSafeIdentifierName(options.defaultScopeName, "defaultScopeName");
  }
  const validation = validateServerStreamTemplate(template);
  if (!validation.ok) {
    const error = new Error(validation.error.message);
    Object.assign(error, validation.error);
    throw error;
  }
  const cacheKey = options.defaultScopeName ?? "";
  const cachedByOptions = streamModuleCache.get(template);
  const cached = cachedByOptions?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const hasComponentCall = hasComponentCallNode(template.root);
  const hasDeferredAwait = hasDeferredAwaitNode(template.root);
  const acceptsStreamOptions = hasDeferredAwait || hasComponentCall;
  const coalescedStatements = renderNodeYieldStatements(template.root, new Set(), "  ").flatMap((line) => {
    const yieldMatch = /^(\s*)yield (.*);$/.exec(line);
    if (yieldMatch) {
      return [
        `${yieldMatch[1]}__tachyonPush(${yieldMatch[2]});`,
        `${yieldMatch[1]}if (__tachyonBufferBytes >= __tachyonFlushBytes) { yield __tachyonBuffer; __tachyonBuffer = ""; __tachyonBufferBytes = 0; }`,
      ];
    }
    if (line.includes(" await ") || line.includes("yield* ")) {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return [
        `${indent}if (__tachyonBuffer) { yield __tachyonBuffer; __tachyonBuffer = ""; __tachyonBufferBytes = 0; }`,
        line,
      ];
    }
    return [line];
  });
  const streamParams = `${options.defaultScopeName ? "inputScope = {}" : "scope"}${acceptsStreamOptions ? ", __tachyonStreamOptions = undefined" : ""}`;
  const lines = [
    ...generatedEscapeHtmlHelperLines,
    ...(hasDynamicUrlAttribute(template.root) ? generatedUrlAttributeHelperLines : []),
    ...(hasComponentCall ? generatedStreamComponentHelperLines : []),
    ...(hasDeferredAwait ? generatedDeferredAwaitHelperLines : []),
    `const escapeMarker = (value) => String(value ?? "").replaceAll("--", "- -").replaceAll(">", "&gt;");`,
    `export const stream = async function* (${streamParams}) {`,
    ...(options.defaultScopeName
      ? [
          `  const localScope = typeof ${options.defaultScopeName} === "function" ? ${options.defaultScopeName}(inputScope) : ${options.defaultScopeName};`,
          `  const scope = localScope && typeof localScope === "object" ? { ...localScope, ...inputScope } : inputScope;`,
        ]
      : []),
    ...(hasDeferredAwait
      ? [
          `  const __tachyonNonceAttr = __tachyonFormatNonce(__tachyonStreamOptions);`,
          `  const __tachyonPendingAwaits = [];`,
        ]
      : []),
    `  const __tachyonFlushBytes = 8192;`,
    `  const __tachyonTextEncoder = new TextEncoder();`,
    `  let __tachyonBuffer = "";`,
    `  let __tachyonBufferBytes = 0;`,
    `  const __tachyonPush = (() => {`,
    `    const nonAsciiCodeUnit = /[\\u0080-\\uffff]/;`,
    `    return (chunk) => {`,
    `      const text = String(chunk ?? "");`,
    `      __tachyonBuffer += text;`,
    `      __tachyonBufferBytes += text.length;`,
    `      if (__tachyonBufferBytes < __tachyonFlushBytes && (text.length > 256 || nonAsciiCodeUnit.test(text))) {`,
    `        __tachyonBufferBytes += __tachyonTextEncoder.encode(text).byteLength - text.length;`,
    `      }`,
    `    };`,
    `  })();`,
    ...coalescedStatements,
    `  if (__tachyonBuffer) { yield __tachyonBuffer; __tachyonBuffer = ""; __tachyonBufferBytes = 0; }`,
    ...(hasDeferredAwait ? [`  yield* __tachyonDrainPendingAwaits(__tachyonPendingAwaits, __tachyonNonceAttr);`] : []),
    `};`,
  ];
  const code = `${lines.join("\n")}\n`;
  const nextCache = cachedByOptions ?? new Map<string, string>();
  nextCache.set(cacheKey, code);
  streamModuleCache.set(template, nextCache);
  return code;
};
