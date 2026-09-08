import { describe, expect, it } from "vitest";
import {
  bindingSourceSpan,
  compileTemplate,
  generateClientHydrationChunkModule,
  compileServerTemplate,
  generateClientModule,
  generateServerModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../src/compiler";
import { setText, textAt } from "../src/runtime/text";
import { parseTemplate } from "../src/compiler/parser";

const mountClientTextBindings = (
  templateHtml: string,
  bindings: Array<{ kind: string; path: number[] }>,
  scope: Record<string, unknown>,
): HTMLElement => {
  document.body.innerHTML = templateHtml;
  const root = document.body.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error("Missing mounted root.");
  }
  for (const binding of bindings) {
    if (binding.kind === "text") {
      const expression = "expression" in binding && typeof binding.expression === "string" ? binding.expression : "";
      setText(textAt(root, binding.path), scope[expression]);
    }
  }
  return root;
};

describe("HTML-first compiler", () => {
  const activeUrlCorpus = [
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
  ];

  it("preserves element, attribute, and text source spans in parser nodes", () => {
    const result = parseTemplate(`<main>\n  <input bind:value={name}>text\n</main>`);
    if (!result.ok) throw new Error(result.error.message);
    const input = result.value.children.find((node) => node.type === "element");
    if (!input || input.type !== "element") throw new Error("Missing input node.");

    expect(input).toMatchObject({ start: 9, openEnd: 34, end: 34 });
    expect(input.attrs[0]).toMatchObject({
      start: 16,
      end: 33,
      nameStart: 16,
      nameEnd: 26,
      valueStart: 27,
      valueEnd: 33,
    });
    const text = result.value.children.find((node) => node.type === "text" && node.value.includes("text"));
    expect(text).toMatchObject({ start: 34, end: 39 });
  });
  it("reuses compiled templates for repeated source strings", () => {
    const source = `<section><h1>{title}</h1></section>`;
    const first = compileTemplate(source);
    const second = compileTemplate(source);

    expect(first.ok).toBe(true);
    expect(second).toBe(first);
  });

  it("freezes cached compiler output so consumers cannot poison later compiles", () => {
    const source = `<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`;
    const first = compileTemplate(source);
    if (!first.ok) throw new Error(first.error.message);
    const list = first.value.client.bindings[0];
    if (!list || list.kind !== "list") throw new Error("Missing list binding.");

    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.value.client.bindings)).toBe(true);
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => {
      (list as { each: string }).each = "poison";
    }).toThrow(TypeError);

    const second = compileTemplate(source);
    expect(second).toBe(first);
    expect(list.each).toBe("rows");
  });

  it("freezes cached compiler errors so consumers cannot poison later failures", () => {
    const source = `<if></if>`;
    const first = compileTemplate(source);
    if (first.ok) throw new Error("Expected compiler failure.");

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.error)).toBe(true);
    expect(() => {
      (first.error as { message: string }).message = "poison";
    }).toThrow(TypeError);

    const second = compileTemplate(source);
    expect(second).toBe(first);
    expect(second.ok ? "" : second.error.message).toBe("<if> requires test={condition}.");
  });

  it("condenses formatting newlines through one shared template tree", () => {
    const source = `<main>
  <ul>
    <li>one</li>
    <li>two</li>
  </ul>
  <p>Hello {name}!</p>
</main>`;
    const preserved = compileTemplate(source, { whitespace: "preserve" });
    const condensed = compileTemplate(source, { whitespace: "condense" });
    if (!preserved.ok) throw new Error(preserved.error.message);
    if (!condensed.ok) throw new Error(condensed.error.message);

    expect(renderServerTemplate(preserved.value, { name: "Ada" })).toContain("\n    <li>");
    expect(renderServerTemplate(condensed.value, { name: "Ada" })).toBe(
      `<main> <ul> <li>one</li> <li>two</li> </ul> <p>Hello <!---->Ada<!---->!</p> </main>`,
    );
    expect(condensed.value.client.templateHtml).toBe(
      `<main> <ul> <li>one</li> <li>two</li> </ul> <p>Hello <!----> <!---->!</p> </main>`,
    );
    expect(condensed).not.toBe(preserved);
    expect(generateServerStreamModule(condensed.value)).not.toContain("\\n");
  });

  it("preserves explicit inline, raw-text, and non-ASCII whitespace while condensing", () => {
    const source = `<main>
  <p><span>Hello </span><strong>world</strong> <em>a\u00a0b</em></p>
  <pre>  pre
    value  </pre>
  <textarea>  text
    value  </textarea>
  <script>line one
    line two</script>
  <style>line one
    line two</style>
</main>`;
    const result = compileTemplate(source, { whitespace: "condense" });
    if (!result.ok) throw new Error(result.error.message);
    const html = renderServerTemplate(result.value, {});

    expect(html).toContain(`<span>Hello </span><strong>world</strong> <em>a\u00a0b</em>`);
    expect(html).toContain(`<pre>  pre\n    value  </pre>`);
    expect(html).toContain(`<textarea>  text\n    value  </textarea>`);
    expect(html).toContain(`<script>line one\n    line two</script>`);
    expect(html).toContain(`<style>line one\n    line two</style>`);
  });

  it.each([
    "pre",
    "textarea",
    "title",
    "script",
    "style",
    "xmp",
    "listing",
    "plaintext",
    "iframe",
    "noembed",
    "noframes",
  ])("preserves whitespace in the %s context for every compiler target", (tagName) => {
    const source = `<${tagName}>line one\n    line two</${tagName}>`;
    const result = compileTemplate(source, { whitespace: "condense" });
    if (!result.ok) throw new Error(result.error.message);

    expect(renderServerTemplate(result.value, {})).toContain("line one\n    line two");
    expect(result.value.client.templateHtml).toContain("line one\n    line two");
    expect(generateServerStreamModule(result.value)).toContain("line one\\n    line two");
  });

  it.each(["script", "style"])("rejects dynamic text inside the %s raw-text element", (tagName) => {
    const source = `<main><${tagName}>{payload}</${tagName}></main>`;
    const result = compileTemplate(source);

    expect(result).toEqual({
      ok: false,
      error: {
        message: `Expressions inside <${tagName}> are not supported; serialize data outside raw text.`,
        offset: source.indexOf("{payload}"),
        endOffset: source.indexOf("{payload}") + "{payload}".length,
      },
    });
  });

  it.each([
    `<script><if test={on}>{value}</if></script>`,
    `<script><for each={items} key={item.id}>{item.value}</for></script>`,
    `<script><b>{value}</b></script>`,
    `<script><if test={on}><for each={items} key={item.id}><b>{item.value}</b></for></if></script>`,
    `<style><if test={on}>@import url({href});</if></style>`,
  ])("rejects raw-text descendant expressions before lowering %s", (source) => {
    const result = compileTemplate(source);
    const expressionStart = source.indexOf("{");
    const expressionEnd = source.indexOf("}", expressionStart) + 1;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a raw-text expression diagnostic.");
    expect(result.error).toMatchObject({
      message: expect.stringMatching(/^Expressions inside <(?:script|style)> are not supported/),
      offset: expressionStart,
      endOffset: expressionEnd,
    });
  });

  it.each(["script", "style"])("parses %s contents as one raw-text node", (tagName) => {
    const result = parseTemplate(`<${tagName}><b>static</b></${tagName.toUpperCase()}>`);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.children).toEqual([expect.objectContaining({ type: "text", value: "<b>static</b>" })]);
  });

  it("keeps script double-escaped text inside the raw-text node", () => {
    const source = `<script><!--<script>\n//</script>\n{payload}</script>`;
    const parsed = parseTemplate(source);
    const compiled = compileTemplate(source);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.children).toEqual([
      expect.objectContaining({ type: "text", value: "<!--<script>\n//</script>\n{payload}" }),
    ]);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("Expected a raw-text expression diagnostic.");
    expect(compiled.error).toMatchObject({
      offset: source.indexOf("{payload}"),
      endOffset: source.indexOf("{payload}") + "{payload}".length,
    });
  });

  it("recognizes a slash-delimited raw-text closing tag", () => {
    const result = parseTemplate("<script>static</script/>");

    expect(result.ok).toBe(true);
  });

  it.each(["textarea", "title"])("keeps dynamic text available inside the %s RCDATA element", (tagName) => {
    const result = compileTemplate(`<${tagName}>{value}</${tagName}>`);

    expect(result.ok).toBe(true);
  });

  it.each(["onclick", "ONLOAD", "srcdoc", "innerhtml", "outerhtml"])(
    "rejects dangerous attribute %s before lowering every compiler target",
    (name) => {
      for (const value of ['"static"', "{value}"]) {
        const source = `<iframe ${name}=${value}></iframe>`;
        const result = compileTemplate(source);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected dangerous attribute diagnostic.");
        expect(result.error).toMatchObject({
          message: `Dangerous attribute is not supported: ${name}.`,
          offset: source.indexOf(name),
          endOffset: source.indexOf(name) + name.length,
        });
      }
    },
  );

  it("keeps framework event directives and ordinary attributes available", () => {
    const result = compileTemplate(`<button on:click={save} aria-label="Save" data-kind={kind}></button>`);

    expect(result.ok).toBe(true);
  });

  it.each(activeUrlCorpus)("rejects active URL %j before lowering every compiler target", (value) => {
    for (const [tagName, attribute] of [
      ["a", "href"],
      ["img", "src"],
      ["form", "action"],
      ["button", "formaction"],
      ["use", "xlink:href"],
    ] as const) {
      const source = `<${tagName} ${attribute}="${value}"></${tagName}>`;
      const result = compileTemplate(source);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected unsafe URL diagnostic.");
      expect(result.error.message).toBe(`Unsafe URL for ${attribute}.`);
    }
  });

  it("rejects active dynamic URLs in interpreted, generated server, and stream output", async () => {
    const result = compileTemplate(`<a href={url}>link</a>`);
    if (!result.ok) throw new Error(result.error.message);
    const scope = { url: "java\tscript:alert(1)" };

    expect(() => renderServerTemplate(result.value, scope)).toThrow("Unsafe URL for href");

    const serverCode = generateServerModule(result.value);
    const serverModule = (await import(
      `data:text/javascript;base64,${Buffer.from(serverCode).toString("base64")}`
    )) as {
      render(scope: Record<string, unknown>): string;
    };
    expect(() => serverModule.render(scope)).toThrow("Unsafe URL for href");

    const streamCode = generateServerStreamModule(result.value);
    const streamModule = (await import(
      `data:text/javascript;base64,${Buffer.from(streamCode).toString("base64")}`
    )) as {
      stream(scope: Record<string, unknown>): AsyncIterable<string>;
    };
    const consumeStream = async (): Promise<void> => {
      for await (const _chunk of streamModule.stream(scope)) {
        // Consume every chunk so URL validation runs at the generated yield boundary.
      }
    };
    await expect(consumeStream()).rejects.toThrow("Unsafe URL for href");
  });

  it("validates meta refresh across static and dynamic compiler targets", async () => {
    const staticUnsafe = compileTemplate(`<meta content="0;url=javascript:alert(1)" http-equiv="refresh">`);
    expect(staticUnsafe.ok).toBe(false);
    if (staticUnsafe.ok) throw new Error("Expected unsafe meta refresh diagnostic.");
    expect(staticUnsafe.error.message).toBe("Unsafe URL for content.");

    const unresolved = compileTemplate(`<meta content="0;url=/safe" http-equiv={mode}>`);
    expect(unresolved.ok).toBe(false);
    if (unresolved.ok) throw new Error("Expected unresolved meta refresh diagnostic.");
    expect(unresolved.error.message).toContain("Dynamic meta refresh mode");

    const dynamic = compileTemplate(`<meta http-equiv="refresh" content={refresh}>`);
    if (!dynamic.ok) throw new Error(dynamic.error.message);
    const unsafeScope = { refresh: "0;url=javascript:alert(1)" };
    expect(() => renderServerTemplate(dynamic.value, unsafeScope)).toThrow("Unsafe URL for content");

    const serverModule = (await import(
      `data:text/javascript;base64,${Buffer.from(generateServerModule(dynamic.value)).toString("base64")}`
    )) as { render(scope: Record<string, unknown>): string };
    expect(() => serverModule.render(unsafeScope)).toThrow("Unsafe URL for content");
    expect(serverModule.render({ refresh: "0;url=/safe" })).toBe(`<meta http-equiv="refresh" content="0;url=/safe">`);
  });

  it("normalizes a mixed-case dynamic URL attribute consistently", async () => {
    const result = compileTemplate(`<img SRC={url}>`);
    if (!result.ok) throw new Error(result.error.message);
    const scope = { url: " \n/images/avatar.png " };

    expect(renderServerTemplate(result.value, scope)).toBe(`<img SRC="/images/avatar.png">`);
    const code = generateServerModule(result.value);
    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      render(scope: Record<string, unknown>): string;
    };
    expect(module.render(scope)).toBe(`<img SRC="/images/avatar.png">`);
  });

  it.each([
    ["svg", `<svg xml:space="preserve"><text>line one\n    line two</text></svg>`],
    ["math", `<math xml:space="preserve"><mtext>line one\n    line two</mtext></math>`],
  ])("inherits static xml:space in %s for every compiler target", (_namespace, source) => {
    const result = compileTemplate(source, { whitespace: "condense" });
    if (!result.ok) throw new Error(result.error.message);
    expect(renderServerTemplate(result.value, {})).toContain("line one\n    line two");
    expect(result.value.client.templateHtml).toContain("line one\n    line two");
    expect(generateServerStreamModule(result.value)).toContain("line one\\n    line two");
  });

  it("resets static xml:space and HTML foreignObject boundaries", () => {
    const source = `<svg xml:space="preserve"><text>keep\n  this</text><g xml:space="default"><text>fold\n  this</text><g xml:space="preserve"><text>keep\n  again</text></g></g><foreignObject><p>fold\n  html</p></foreignObject></svg>`;
    const result = compileTemplate(source, { whitespace: "condense" });
    if (!result.ok) throw new Error(result.error.message);
    const html = renderServerTemplate(result.value, {});
    expect(html).toContain("keep\n  this");
    expect(html).toContain("fold this");
    expect(html).toContain("keep\n  again");
    expect(html).toContain("fold html");
  });

  it.each([`{policy}`, "PRESERVE", "unknown"])("ignores non-static xml:space value %s", (value) => {
    const result = compileTemplate(`<svg xml:space=${value}><text>fold\n  this</text></svg>`, {
      whitespace: "condense",
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(renderServerTemplate(result.value, { policy: "preserve" })).toContain("fold this");
  });

  it("condenses newline-derived whitespace at fragment boundaries without deleting separators", () => {
    const source = `<main><ul><for each={rows} key={row}>
      <li>{row}</li>
    </for></ul><if test={visible}> <span>kept</span> </if></main>`;
    const result = compileTemplate(source, { whitespace: "condense" });
    if (!result.ok) throw new Error(result.error.message);

    const list = result.value.client.bindings.find((binding) => binding.kind === "list");
    const conditional = result.value.client.bindings.find((binding) => binding.kind === "if");
    expect(list).toMatchObject({ templateHtml: ` <li> </li> ` });
    expect(list?.bindings).toContainEqual(expect.objectContaining({ kind: "text", path: [1, 0] }));
    expect(conditional).toMatchObject({ templateHtml: ` <span>kept</span> ` });
  });

  it("never rewrites whitespace inside text expressions", () => {
    const expression = "`a\n  b`";
    const source = `<p>\n      Before {${expression}} after\n      text\n    </p>`;
    const result = compileTemplate(source, { whitespace: "condense" });
    if (!result.ok) throw new Error(result.error.message);

    expect(renderServerTemplate(result.value, {})).toBe(`<p> Before <!---->a\n  b<!----> after text </p>`);
    const binding = result.value.client.bindings.find((candidate) => candidate.kind === "text");
    expect(binding).toMatchObject({ expression });
    expect(generateServerStreamModule(result.value)).toContain(`escapeHtml("a\\n  b")`);
  });

  it("keeps one separator at inline newline boundaries and protects nested directives in raw text", () => {
    const inline = compileTemplate(`<p><span>Hello</span>\n  world and\n  <strong>friends</strong></p>`, {
      whitespace: "condense",
    });
    const raw = compileTemplate(`<pre><if test={show}>\n  <span>x</span>\n</if></pre>`, { whitespace: "condense" });
    const fragment = compileTemplate(`<p>Hello<if test={show}>\n  <strong>world</strong>\n</if>!</p>`, {
      whitespace: "condense",
    });
    if (!inline.ok) throw new Error(inline.error.message);
    if (!raw.ok) throw new Error(raw.error.message);
    if (!fragment.ok) throw new Error(fragment.error.message);

    expect(renderServerTemplate(inline.value, {})).toBe(`<p><span>Hello</span> world and <strong>friends</strong></p>`);
    expect(renderServerTemplate(raw.value, { show: true })).toBe(`<pre>\n  <span>x</span>\n</pre>`);
    expect(renderServerTemplate(fragment.value, { show: true })).toBe(`<p>Hello <strong>world</strong> !</p>`);
  });

  it("caches generated target modules for repeated compiled template objects", () => {
    const result = compileTemplate(`<section><h1>{title}</h1></section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const firstClientCode = generateClientModule(result.value, { reactive: true });
    const firstServerCode = generateServerModule(result.value);
    const firstStreamCode = generateServerStreamModule(result.value);
    const firstRenderer = compileServerTemplate(result.value);
    const firstRenderedHtml = renderServerTemplate(result.value, { title: "Hello" });

    expect(() => {
      (result.value.root as { tagName: string }).tagName = "article";
    }).toThrow(TypeError);
    expect(() => {
      (result.value.client as { templateHtml: string }).templateHtml = "<article></article>";
    }).toThrow(TypeError);

    expect(generateClientModule(result.value, { reactive: true })).toBe(firstClientCode);
    expect(generateServerModule(result.value)).toBe(firstServerCode);
    expect(generateServerStreamModule(result.value)).toBe(firstStreamCode);
    expect(compileServerTemplate(result.value)).toBe(firstRenderer);
    expect(renderServerTemplate(result.value, { title: "Hello" })).toBe(firstRenderedHtml);
  });

  it("extracts text bindings while keeping a static client template", () => {
    const result = compileTemplate(`<tr><td>{row.id}</td><td><a>{row.label}</a></td></tr>`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe("<tr><td> </td><td><a> </a></td></tr>");
    expect(result.value.client.bindings).toEqual([
      { kind: "text", path: [0, 0], expression: "row.id" },
      { kind: "text", path: [1, 0, 0], expression: "row.label" },
    ]);
  });

  it("preserves static text around client text bindings after mounting", () => {
    const result = compileTemplate(`<p>Hello {name}!</p>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const root = mountClientTextBindings(result.value.client.templateHtml, result.value.client.bindings, {
      name: "World",
    });

    expect(root.textContent).toBe("Hello World!");
  });

  it("keeps multiple expressions in one text node independent after client mounting", () => {
    const result = compileTemplate(`<p>{a} and {b}</p>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const root = mountClientTextBindings(result.value.client.templateHtml, result.value.client.bindings, {
      a: "x",
      b: "y",
    });

    expect(root.textContent).toBe("x and y");
  });

  it("matches SSR text node layout to client bindings for mixed text", () => {
    const result = compileTemplate(`<section><p>Hello {name}!</p><span>{a} {b}</span></section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const html = renderServerTemplate(result.value, { name: "World", a: "x", b: "y" });
    document.body.innerHTML = html;
    const root = document.body.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      throw new Error("Missing SSR root.");
    }

    expect(html).toBe(`<section><p>Hello <!---->World<!---->!</p><span>x<!----> <!---->y</span></section>`);
    for (const binding of result.value.client.bindings) {
      if (binding.kind === "text") {
        expect(textAt(root, binding.path)).toBeInstanceOf(Text);
      }
    }
    expect(generateServerModule(result.value)).toContain(`"<!---->"`);
    expect(generateServerStreamModule(result.value)).toContain(`__tachyonPush("<!---->");`);
  });

  it("keeps short-circuit text expressions aligned across SSR targets", async () => {
    const result = compileTemplate("<p>{user && user.name}</p>");
    if (!result.ok) throw new Error(result.error.message);
    const scope = { user: null };
    const expected = "<p><!--td:text--></p>";

    expect(renderServerTemplate(result.value, scope)).toBe(expected);

    const serverModule = (await import(
      `data:text/javascript;base64,${Buffer.from(generateServerModule(result.value)).toString("base64")}`
    )) as { render(scope: Record<string, unknown>): string };
    expect(serverModule.render(scope)).toBe(expected);

    const streamModule = (await import(
      `data:text/javascript;base64,${Buffer.from(generateServerStreamModule(result.value)).toString("base64")}`
    )) as { stream(scope: Record<string, unknown>): AsyncIterable<string> };
    const chunks: string[] = [];
    for await (const chunk of streamModule.stream(scope)) chunks.push(chunk);
    expect(chunks.join("")).toBe(expected);
  });

  it.each(["", null, undefined])(
    "preserves an empty text hydration anchor for %j across server targets",
    async (value) => {
      const result = compileTemplate(`<p>a{value}b</p>`);
      if (!result.ok) throw new Error(result.error.message);
      const scope = { value };
      const expected = `<p>a<!----><!--td:text--><!---->b</p>`;

      expect(renderServerTemplate(result.value, scope)).toBe(expected);

      const serverModule = (await import(
        `data:text/javascript;base64,${Buffer.from(generateServerModule(result.value)).toString("base64")}`
      )) as { render(scope: Record<string, unknown>): string };
      expect(serverModule.render(scope)).toBe(expected);

      const streamModule = (await import(
        `data:text/javascript;base64,${Buffer.from(generateServerStreamModule(result.value)).toString("base64")}`
      )) as { stream(scope: Record<string, unknown>): AsyncIterable<string> };
      const chunks: string[] = [];
      for await (const chunk of streamModule.stream(scope)) chunks.push(chunk);
      expect(chunks.join("")).toBe(expected);

      document.body.innerHTML = expected;
      const root = document.body.firstElementChild;
      if (!(root instanceof HTMLElement)) throw new Error("Missing SSR root.");
      const binding = result.value.client.bindings.find((candidate) => candidate.kind === "text");
      if (!binding || binding.kind !== "text") throw new Error("Missing text binding.");
      const target = textAt(root, binding.path);
      expect(target).toBeInstanceOf(Text);
      expect(root.textContent).toBe("ab");
      setText(target, "Z");
      expect(root.textContent).toBe("aZb");
    },
  );

  it("throws when a text binding path is missing or resolves to a non-text node", () => {
    document.body.innerHTML = `<p><span></span></p>`;
    const root = document.body.firstElementChild;
    if (!(root instanceof HTMLElement)) throw new Error("Missing root.");

    expect(() => textAt(root, [1])).toThrow("Missing text binding node at path 1");
    expect(() => textAt(root, [0])).toThrow("Text binding path 0 resolved to SPAN instead of a Text node");
  });

  it.each([
    ["implicit", `<table><tr><td>{value}</td></tr></table>`],
    ["explicit", `<table><tbody><tr><td>{value}</td></tr></tbody></table>`],
  ])("keeps %s tbody text bindings aligned with the parsed DOM", (_kind, source) => {
    const result = compileTemplate(source);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.client.templateHtml).toBe(`<table><tbody><tr><td> </td></tr></tbody></table>`);
    const root = mountClientTextBindings(result.value.client.templateHtml, result.value.client.bindings, {
      value: "Updated",
    });
    expect(root.querySelector("tbody td")?.textContent).toBe("Updated");
    expect(renderServerTemplate(result.value, { value: "Server" })).toBe(
      `<table><tbody><tr><td>Server</td></tr></tbody></table>`,
    );
  });

  it("places table row list bindings inside a normalized tbody", () => {
    const result = compileTemplate(`<table><for each={rows} key={row.id}><tr><td>{row.label}</td></tr></for></table>`);
    if (!result.ok) throw new Error(result.error.message);
    const list = result.value.client.bindings.find((binding) => binding.kind === "list");

    expect(result.value.client.templateHtml).toBe(`<table><tbody></tbody></table>`);
    expect(list).toMatchObject({ kind: "list", path: [0], templateHtml: `<tr><td> </td></tr>` });
    expect(renderServerTemplate(result.value, { rows: [{ id: 1, label: "One" }] })).toBe(
      `<table><tbody><tr><td>One</td></tr></tbody></table>`,
    );
  });

  it("normalizes direct col children while preserving valid select and optgroup paths", () => {
    const columns = compileTemplate(`<table><col><col></table>`);
    const select = compileTemplate(`<select><optgroup label="Group"><option>{label}</option></optgroup></select>`);
    if (!columns.ok) throw new Error(columns.error.message);
    if (!select.ok) throw new Error(select.error.message);

    expect(columns.value.client.templateHtml).toBe(`<table><colgroup><col><col></colgroup></table>`);
    const root = mountClientTextBindings(select.value.client.templateHtml, select.value.client.bindings, {
      label: "Choice",
    });
    expect(root.querySelector("optgroup option")?.textContent).toBe("Choice");
  });

  it.each([
    `<table><div>{value}</div></table>`,
    `<table>text<tr><td>x</td></tr></table>`,
    `<select><div>x</div></select>`,
  ])("reports unsupported HTML tree construction for %s", (source) => {
    const result = compileTemplate(source);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected tree construction diagnostic.");
    expect(result.error.message).toContain("Unsupported HTML tree construction");
    expect(result.error.offset).toBeGreaterThanOrEqual(0);
  });

  it("omits closing tags for void elements in client and server targets", () => {
    const result = compileTemplate(`<div><br/>{label}<hr/></div>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<div><br> <hr></div>`);
    expect(renderServerTemplate(result.value, { label: "Ready" })).toBe(`<div><br>Ready<hr></div>`);
    expect(generateServerStreamModule(result.value)).not.toContain(`</hr>`);
  });

  it("accepts bare void elements and drops HTML comments without shifting bindings", () => {
    const result = compileTemplate(`<div><!-- note --><br><input type="text"><param name="movie">{label}</div>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<div><br><input type="text"><param name="movie"> </div>`);
    expect(result.value.client.bindings).toEqual([{ kind: "text", path: [3], expression: "label" }]);
    expect(renderServerTemplate(result.value, { label: "Ready" })).toBe(
      `<div><br><input type="text"><param name="movie">Ready</div>`,
    );
    expect(generateServerModule(result.value)).not.toContain(`</param>`);
    expect(generateServerStreamModule(result.value)).not.toContain(`</param>`);
  });

  it("escapes quoted static attributes in generated markup", () => {
    const result = compileTemplate(`<button title='say "hi"' data-note="rock & roll">Save</button>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(
      `<button title="say &quot;hi&quot;" data-note="rock &amp; roll">Save</button>`,
    );
    expect(renderServerTemplate(result.value, {})).toBe(
      `<button title="say &quot;hi&quot;" data-note="rock &amp; roll">Save</button>`,
    );
  });

  it("separates class and event directives from static markup", () => {
    const result = compileTemplate(`<button class="btn" class:danger={selected} on:click={select}>{label}</button>`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<button class="btn"> </button>`);
    expect(result.value.client.bindings).toEqual([
      { kind: "class", path: [], className: "danger", expression: "selected" },
      { kind: "event", path: [], eventName: "click", handler: "select" },
      { kind: "text", path: [0], expression: "label" },
    ]);
  });

  it("renders an escaped server string with static and dynamic classes", () => {
    const result = compileTemplate(`<button class="btn" class:danger={selected} title={label}>{label}</button>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(
      renderServerTemplate(result.value, {
        selected: true,
        label: `<Save & close>`,
      }),
    ).toBe(`<button class="btn danger" title="&lt;Save &amp; close&gt;">&lt;Save &amp; close&gt;</button>`);
  });

  it("renders a dynamic base class with directive classes safely across server targets", async () => {
    const result = compileTemplate(`<div class={base} class:active={active}></div>`);
    if (!result.ok) throw new Error(result.error.message);
    const scope = { base: `card" data-x="1`, active: true };
    const expected = `<div class="card&quot; data-x=&quot;1 active"></div>`;

    expect(renderServerTemplate(result.value, scope)).toBe(expected);
    expect(result.value.client.bindings).toEqual([
      { kind: "attr", path: [], name: "class", expression: "base" },
      { kind: "class", path: [], className: "active", expression: "active" },
    ]);

    const serverModule = (await import(
      `data:text/javascript;base64,${Buffer.from(generateServerModule(result.value)).toString("base64")}`
    )) as { render(scope: Record<string, unknown>): string };
    expect(serverModule.render(scope)).toBe(expected);

    const streamModule = (await import(
      `data:text/javascript;base64,${Buffer.from(generateServerStreamModule(result.value)).toString("base64")}`
    )) as { stream(scope: Record<string, unknown>): AsyncIterable<string> };
    const chunks: string[] = [];
    for await (const chunk of streamModule.stream(scope)) chunks.push(chunk);
    expect(chunks.join("")).toBe(expected);

    const collidingScope = { base: "card active", active: false };
    const collidingExpected = `<div class="card active"></div>`;
    expect(renderServerTemplate(result.value, collidingScope)).toBe(collidingExpected);
    expect(serverModule.render(collidingScope)).toBe(collidingExpected);
    const collidingChunks: string[] = [];
    for await (const chunk of streamModule.stream(collidingScope)) collidingChunks.push(chunk);
    expect(collidingChunks.join("")).toBe(collidingExpected);
  });

  it("accepts expression syntax in text and braced attributes", () => {
    const result = compileTemplate(
      `<section data-count={count + 1} title={format(label)}><p>{selected ? label : "none"}</p></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.bindings).toEqual([
      { kind: "attr", path: [], name: "data-count", expression: "count + 1" },
      { kind: "attr", path: [], name: "title", expression: "format(label)" },
      { kind: "text", path: [0, 0], expression: `selected ? label : "none"` },
    ]);
    expect(
      renderServerTemplate(result.value, {
        count: 2,
        label: "Ready",
        selected: false,
        format: (value: string) => `Status: ${value}`,
      }),
    ).toBe(`<section data-count="3" title="Status: Ready"><p>none</p></section>`);
  });

  it.each([
    ["<div title={format(`a}b`)}></div>", "format(`a}b`)"],
    ['<div title={`a${value ? `b}c` : "d"}`}></div>', '`a${value ? `b}c` : "d"}`'],
    ["<div title={value /* } */}></div>", "value /* } */"],
    ["<div title={value // }\n + 1}></div>", "value // }\n + 1"],
    ["<div title={/}/.test(value)}></div>", "/}/.test(value)"],
    ["<div title={/[}]/.test(value)}></div>", "/[}]/.test(value)"],
    [String.raw`<div title={/a\/${"}"}b/.test(value)}></div>`, String.raw`/a\/${"}"}b/.test(value)`],
    ["<div title={value / 2}></div>", "value / 2"],
  ])("keeps JavaScript lexical braces inside an attribute expression: %s", (source, expression) => {
    const result = compileTemplate(source);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.client.bindings).toContainEqual({
      kind: "attr",
      path: [],
      name: "title",
      expression,
    });
  });

  it("extracts attr, style, ref, and form model bindings from client markup", () => {
    const result = compileTemplate(
      `<section data-count={count + 1} style:width={size + "px"} ref={refs.panel}><input bind:value={user.name}></input><label><input bind:checked={user.active}></input>{user.name}</label></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<section><input><label><input> </label></section>`);
    expect(result.value.client.bindings).toEqual([
      { kind: "attr", path: [], name: "data-count", expression: "count + 1" },
      { kind: "style", path: [], name: "width", expression: `size + "px"` },
      { kind: "ref", path: [], expression: "refs.panel" },
      { kind: "model", path: [0], property: "value", expression: "user.name" },
      { kind: "model", path: [1, 0], property: "checked", expression: "user.active" },
      { kind: "text", path: [1, 1], expression: "user.name" },
    ]);

    const refs: { panel?: Element } = {};
    expect(renderServerTemplate(result.value, { count: 2, size: 10, user: { name: "Ada", active: true }, refs })).toBe(
      `<section data-count="3" style="width:10px"><input><label><input>Ada</label></section>`,
    );

    const code = generateClientModule(result.value);
    expect(code).toContain(`from "tachyon-dom/runtime/attr"`);
    expect(code).toContain(`from "tachyon-dom/runtime/form"`);
    expect(code).toContain(`__tachyonSetAttributeValue(root, "data-count", (scope.count + 1));`);
    expect(code).toContain(`__tachyonSetStyleValue(root, "width", (scope.size + "px"));`);
    expect(code).toContain(`cleanups.push(__tachyonBindRef(scope, (scope) => scope.refs, "panel", root));`);
    expect(code).toContain(`__tachyonBindControl(__tachyonElementAt(root, [0]), "value"`);
    expect(code).toContain(`__tachyonBindControl(__tachyonElementAt(root, [1,0]), "checked"`);
  });

  it("preserves explicit row and index names while keeping legacy key inference", () => {
    const result = compileTemplate(
      `<ul><for each={rows} as="entry" index="position" key={entry.id}><li>{entry.id}:{position}</li></for></ul>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.ir.directives).toContainEqual({
      kind: "for",
      path: [0],
      each: "rows",
      key: "entry.id",
      itemName: "entry",
      indexName: "position",
    });
    expect(result.value.client.bindings[0]).toMatchObject({
      kind: "list",
      itemName: "entry",
      indexName: "position",
    });
  });

  it.each(["class", "await"])("rejects reserved <for> binding name %s", (name) => {
    const result = compileTemplate(
      `<ul><for each={rows} as="${name}" index="position" key={row.id}><li>{row.id}</li></for></ul>`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected reserved binding name to fail.");
    expect(result.error.message).toContain("valid identifier");
  });

  it("rejects duplicate explicit <for> binding names", () => {
    const result = compileTemplate(
      `<ul><for each={rows} as="row" index="row" key={row.id}><li>{row.id}</li></for></ul>`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected duplicate binding names to fail.");
    expect(result.error.message).toContain("different identifiers");
  });

  it("rejects unsafe default scope identifiers in every generated target", () => {
    const result = compileTemplate(`<main>{title}</main>`);
    if (!result.ok) throw new Error(result.error.message);
    const unsafeName = "scope; globalThis.__tachyonInjected = true; /*";

    expect(() => generateClientModule(result.value, { defaultScopeName: unsafeName })).toThrow("safe identifier");
    expect(() => generateServerModule(result.value, { defaultScopeName: unsafeName })).toThrow("safe identifier");
    expect(() => generateServerStreamModule(result.value, { defaultScopeName: unsafeName })).toThrow("safe identifier");
  });

  it("generates modular client code that imports only needed runtime helpers", () => {
    const result = compileTemplate(`<button class:danger={selected} on:click={select}>{label}</button>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`from "tachyon-dom/runtime/text"`);
    expect(code).toContain(`from "tachyon-dom/runtime/class"`);
    expect(code).toContain(`from "tachyon-dom/runtime/event"`);
    expect(code).toContain(`export const templateHtml = "<button> </button>";`);
    expect(code).toContain(`__tachyonSetText(__tachyonTextAt(root, [0]), scope.label);`);
    expect(code).toContain(`__tachyonSetClassPresence(root, "danger", scope.selected);`);
    expect(code).toContain(`cleanups.push(__tachyonDelegate(root, "click", [], scope.select));`);
  });

  it("writes a statically known class attribute through the class setter", () => {
    const result = compileTemplate(`<div class={theme}><span class={inner} title={label}></span></div>`);
    if (!result.ok) throw new Error(result.error.message);

    const code = generateClientModule(result.value);

    expect(code).toContain(`__tachyonSetClassValue(root, scope.theme);`);
    expect(code).toContain(`__tachyonSetClassValue(__tachyonElementAt(root, [0]), scope.inner);`);
    expect(code).toContain(`__tachyonSetAttributeValue(__tachyonElementAt(root, [0]), "title", scope.label);`);
    expect(code).toContain(`setClassValue as __tachyonSetClassValue`);
  });

  it("keeps a class-only template free of the generic attribute runtime", () => {
    const result = compileTemplate(`<div class={theme} class:active={selected}></div>`);
    if (!result.ok) throw new Error(result.error.message);

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).not.toContain(`tachyon-dom/runtime/attr`);
    expect(code).toContain(`from "tachyon-dom/runtime/class"`);
    expect(code).toContain(`__tachyonSetClassValue(__tachyonTarget0, __tachyonRead(scope.theme))`);
    expect(code).toContain(`__tachyonSetClassPresence(__tachyonTarget1, "active", __tachyonRead(scope.selected))`);
    expect(code).toContain(`{"path":[],"name":"class"}`);
  });

  it("wraps every generated bind in an ownership root", () => {
    const result = compileTemplate(`<button>{label}</button>`);
    if (!result.ok) throw new Error(result.error.message);

    const code = generateClientModule(result.value);

    expect(code).toContain(`import { createRoot as __tachyonCreateRoot } from "tachyon-dom/runtime/signal";`);
    expect(code).toContain(
      `export const bind = (root, inputScope = {}) => __tachyonCreateRoot((__tachyonDisposeRoot) => {`,
    );
    expect(code).toContain(`const scope = inputScope;`);
    // Nothing in this template registers a disposer, so the module returns the root's own idempotent one.
    expect(code).toContain(`return __tachyonDisposeRoot;`);
    expect(code).not.toContain(`const cleanups = [];`);

    const withCleanup = compileTemplate(`<button on:click={save}>{label}</button>`);
    if (!withCleanup.ok) throw new Error(withCleanup.error.message);
    const cleanupCode = generateClientModule(withCleanup.value);
    expect(cleanupCode).toContain(`const cleanups = [];`);
    expect(cleanupCode).toContain(`__tachyonDisposeRoot();`);
  });

  it("generates class bindings against nested element paths", () => {
    const result = compileTemplate(`<div><span class:active={selected}>{label}</span></div>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(
      `import { elementAt as __tachyonElementAt, setClassPresence as __tachyonSetClassPresence } from "tachyon-dom/runtime/class";`,
    );
    expect(code).toContain(`__tachyonSetClassPresence(__tachyonElementAt(root, [0]), "active", scope.selected);`);
  });

  it("can generate reactive client bindings with modular signal imports", () => {
    const result = compileTemplate(
      `<section><h1>{title}</h1><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(
      `import { createRoot as __tachyonCreateRoot, effect as __tachyonEffect, read as __tachyonRead } from "tachyon-dom/runtime/signal";`,
    );
    expect(code).toContain(`const cleanups = [];`);
    expect(code).toContain(`const __tachyonTarget0 = __tachyonTextAt(root, [0,0]);`);
    expect(code).toContain(
      `cleanups.push(__tachyonEffect(() => __tachyonSetText(__tachyonTarget0, __tachyonRead(scope.title))));`,
    );
    expect(code).toContain(
      `cleanups.push(__tachyonEffect(() => __tachyonMountTextKeyedList(__tachyonTarget1, [], __tachyonRead(scope.rows)`,
    );
    expect(code).toContain(`return () => {`);
  });

  it("owns default scope reactivity and DOM cleanups with one generated root", () => {
    const result = compileTemplate(`<button on:click={increment}>{count}</button>`);
    if (!result.ok) throw new Error(result.error.message);

    const code = generateClientModule(result.value, { reactive: true, defaultScopeName: "createScope" });

    expect(code).toContain(
      `import { createRoot as __tachyonCreateRoot, effect as __tachyonEffect, read as __tachyonRead } from "tachyon-dom/runtime/signal";`,
    );
    expect(code).toContain(
      `export const bind = (root, inputScope = {}) => __tachyonCreateRoot((__tachyonDisposeRoot) => {`,
    );
    expect(code.indexOf(`const scope = __tachyonCreateScope(inputScope);`)).toBeGreaterThan(
      code.indexOf(`__tachyonCreateRoot((__tachyonDisposeRoot) => {`),
    );
    expect(code).toContain(`__tachyonDisposeRoot();`);
    expect(code).toContain(`for (const cleanup of cleanups) {`);
    expect(code).toContain(`if (__tachyonCleanupFailed) throw __tachyonCleanupError;`);
  });

  it("keeps nested client control-flow bindings instead of dropping them", () => {
    const result = compileTemplate(
      `<section><if test={visible}><ul><for each={groups} key={group.id}><li>{group.name}<ul><for each={group.items} key={item.id}><li>{item.label}</li></for></ul></li></for></ul><if test={showNote}><p>{note}</p></if></if></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const [outer] = result.value.client.bindings;
    expect(outer?.kind).toBe("if");
    if (outer?.kind !== "if") {
      throw new Error("Missing outer conditional binding.");
    }
    expect(outer.bindings.map((binding) => binding.kind)).toEqual(["list", "if"]);
    const [list] = outer.bindings;
    expect(list?.kind).toBe("list");
    if (list?.kind !== "list") {
      throw new Error("Missing nested list binding.");
    }
    expect(list.bindings.some((binding) => binding.kind === "list")).toBe(true);

    const code = generateClientModule(result.value);
    expect(code).toContain(`kind: "list"`);
    expect(code).toContain(`kind: "if"`);
    expect(code).toContain(`signature: "list:`);
    expect(code).toContain(`signature: "if:`);
  });

  it("hoists reactive binding node lookups outside effect bodies", () => {
    const result = compileTemplate(
      `<section><h1>{title}</h1><button class:active={active} title={title} style:width={width} bind:value={title}></button></section>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`const __tachyonTarget0 = __tachyonTextAt(root, [0,0]);`);
    expect(code).toContain(`cleanups.push(__tachyonEffect(() => __tachyonSetText(__tachyonTarget0`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetText(__tachyonTextAt(root`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetClassPresence(__tachyonElementAt(root`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetAttributeValue(__tachyonElementAt(root`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetStyleValue(__tachyonElementAt(root`);
    expect(code).not.toContain(`__tachyonEffect(() => __tachyonSetControlValue(__tachyonElementAt(root`);
  });

  it("extracts store tags without adding client DOM nodes", () => {
    const result = compileTemplate(`<section><store count={initialCount}/><button>{count}</button></section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<section><button> </button></section>`);
    expect(result.value.client.stores).toEqual([{ name: "count", initial: "initialCount" }]);

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`import { createStore as __tachyonCreateStore } from "tachyon-dom/runtime/store";`);
    expect(code).toContain(`const state = __tachyonCreateStore({ ...scope, count: scope.initialCount });`);
    expect(code).toContain(`const __tachyonTarget0 = __tachyonTextAt(root, [0,0]);`);
    expect(code).toContain(`__tachyonSetText(__tachyonTarget0, __tachyonRead(state.count))`);

    const withoutStore = compileTemplate(`<section><button>{count}</button></section>`);
    if (!withoutStore.ok) {
      throw new Error(withoutStore.error.message);
    }
    expect(generateClientModule(withoutStore.value, { reactive: true })).not.toContain(`runtime/store`);
  });

  it("hoists conditional options and emits compiled binding readers", () => {
    const result = compileTemplate(`<section><if test={active}><button title={label}>{label}</button></if></section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).toContain(`const conditionalOptions0 = {`);
    expect(code).toContain(`signature: "if:`);
    expect(code).toContain(`read: (scope) => scope.label`);
    expect(code).toContain(
      `cleanups.push(__tachyonEffect(() => __tachyonMountGeneratedConditionalCore(root, [0], __tachyonConditionalVisibility0(), scope, conditionalOptions0)));`,
    );
    expect(code).not.toContain(
      `__tachyonMountGeneratedConditional(__tachyonTarget0, [], __tachyonRead(scope.active), scope, {`,
    );
  });

  it("falls back to the generic conditional runtime for unsupported branch capabilities", () => {
    const sources = [
      `<main><if test={active}><form><input bind:value={value}></form></if></main>`,
      `<main><if test={active}><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></if></main>`,
      `<main><if test={active}><store count={initial}/><output>{count}</output></if></main>`,
      `<main><if test={active}><section hydrate:id={boundary}><p>ready</p></section></if></main>`,
    ];

    for (const source of sources) {
      const result = compileTemplate(source);
      if (!result.ok) throw new Error(result.error.message);
      const code = generateClientModule(result.value, { reactive: true });

      expect(code).toContain(`from "tachyon-dom/runtime/conditional"`);
      // The anchor preparation lives beside the lightweight runtime and every branch needs it to adopt SSR
      // nodes, so only the lightweight mount entry has to stay out.
      expect(code).not.toContain(`mountGeneratedConditionalCore`);
      expect(code).toContain(`__tachyonPrepareConditionalCore(root, [`);
      expect(code).toContain(`__tachyonMountGeneratedConditional(`);
    }
  });

  it("generates a separate server target without client runtime imports", () => {
    const result = compileTemplate(`<button class:danger={selected}>{label}</button>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`export const render = (scope) =>`);
    expect(code).toContain(`escapeHtml(scope.label)`);
    expect(code).toContain(`scope.selected ? " danger" : ""`);
    expect(code).toContain(`" class=`);
    expect(code).not.toContain(`tachyon-dom/runtime`);
  });

  it("folds fully static SSR classes into the open tag literal", () => {
    const result = compileTemplate(`<section class="card primary">Ready</section>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`"<section class=\\"card primary\\">"`);
    expect(code).not.toContain(`.trim()`);
    expect(code).not.toContain(`? " class=`);
  });

  it("generates single-pass HTML escaping helpers for server targets", () => {
    const result = compileTemplate(`<p>{label}</p>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const serverCode = generateServerModule(result.value);
    const streamCode = generateServerStreamModule(result.value);

    expect(serverCode).toContain(`HTML_ESCAPE_PATTERN.test(text)`);
    expect(streamCode).toContain(`HTML_ESCAPE_PATTERN.test(text)`);
    expect(serverCode).toContain(`replace(/[&<>"']/g`);
    expect(streamCode).toContain(`replace(/[&<>"']/g`);
    expect(serverCode).not.toContain(`replaceAll("&", "&amp;").replaceAll("<", "&lt;")`);
    expect(streamCode).not.toContain(`replaceAll("&", "&amp;").replaceAll("<", "&lt;")`);
  });

  it("generates server list code that uses loop-local item scope", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`scope.rows.map((row) =>`);
    expect(code).toContain(`escapeHtml(row.id)`);
    expect(code).not.toContain(`escapeHtml(scope.row.id)`);
  });

  it("generates a streaming server target without client runtime imports", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerStreamModule(result.value);

    expect(code).toContain(`export const stream = async function* (scope)`);
    expect(code).toContain(`for (const row of scope.rows)`);
    expect(code).toContain(`__tachyonPush((escapeHtml(row.id) || "<!--td:text-->"));`);
    expect(code).not.toContain(`tachyon-dom/runtime`);
  });

  it("records hydrate boundaries and emits server markers", () => {
    const result = compileTemplate(`<main><section hydrate:id={islandId}><button>{label}</button></section></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.hydrationBoundaries).toEqual([{ path: [0], id: "islandId", idKind: "expression" }]);
    expect(result.value.client.templateHtml).toBe(`<main><section><button> </button></section></main>`);
    expect(renderServerTemplate(result.value, { islandId: "cart", label: "Buy" })).toBe(
      `<main><!--tachyon-hydrate:cart:start--><section><button>Buy</button></section><!--tachyon-hydrate:cart:end--></main>`,
    );

    const code = generateServerStreamModule(result.value);

    expect(code).toContain(`__tachyonPush("<!--tachyon-hydrate:" + escapeMarker(scope.islandId) + ":start-->");`);
    expect(code).toContain(`__tachyonPush("<!--tachyon-hydrate:" + escapeMarker(scope.islandId) + ":end-->");`);
  });

  it("keeps source hydration IDs distinct across sibling and nested conditional roots", () => {
    const compiled = compileTemplate(
      `<main><if test={shown}><section hydrate:interaction="click"><input bind:value={draft}></section><aside hydrate:interaction="click">Aside</aside></if><if test={shown}><article><if test={shown}><footer hydrate:interaction="click"><input bind:value={draft}></footer></if></article></if></main>`,
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const first = compiled.value.client.bindings[0];
    const second = compiled.value.client.bindings[1];
    if (first?.kind !== "if" || second?.kind !== "if") throw new Error("Missing branches");
    const nested = second.bindings.find((binding) => binding.kind === "if");
    if (nested?.kind !== "if") throw new Error("Missing nested branch");
    expect(first.hydrationBoundaries?.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: "td-h-0-0", path: [0] },
      { id: "td-h-0-1", path: [1] },
    ]);
    expect(nested.hydrationBoundaries?.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: "td-h-1-0-0-0", path: [] },
    ]);
    const html = renderServerTemplate(compiled.value, { shown: true, draft: "" });
    const stream = generateServerStreamModule(compiled.value);
    for (const id of ["td-h-0-0", "td-h-0-1", "td-h-1-0-0-0"]) {
      expect(html.split(`<!--tachyon-hydrate:${id}:start-->`)).toHaveLength(2);
      expect(stream).toContain(`escapeMarker("${id}")`);
    }
  });

  it("generates stable hydrate ids and records shorthand hydration strategies", () => {
    const result = compileTemplate(
      `<main><section hydrate><button>{label}</button></section><aside hydrate:visible="128px">{summary}</aside><footer hydrate:interaction="pointerenter">{status}</footer></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(
      `<main><section><button> </button></section><aside> </aside><footer> </footer></main>`,
    );
    expect(result.value.client.hydrationBoundaries).toEqual([
      { path: [0], id: "td-h-0", idKind: "static" },
      { path: [1], id: "td-h-1", idKind: "static", strategy: "visible", rootMargin: "128px" },
      { path: [2], id: "td-h-2", idKind: "static", strategy: "interaction", interaction: "pointerenter" },
    ]);
    expect(result.value.ir.directives).toContainEqual({
      kind: "hydrate",
      path: [1],
      id: "td-h-1",
      idKind: "static",
      strategy: "visible",
      rootMargin: "128px",
    });
    expect(renderServerTemplate(result.value, { label: "Buy", summary: "Ready", status: "Idle" })).toBe(
      `<main><!--tachyon-hydrate:td-h-0:start--><section><button>Buy</button></section><!--tachyon-hydrate:td-h-0:end--><!--tachyon-hydrate:td-h-1:start--><aside>Ready</aside><!--tachyon-hydrate:td-h-1:end--><!--tachyon-hydrate:td-h-2:start--><footer>Idle</footer><!--tachyon-hydrate:td-h-2:end--></main>`,
    );

    const code = generateServerStreamModule(result.value);
    expect(code).toContain(`escapeMarker("td-h-0")`);
    expect(code).toContain(`escapeMarker("td-h-1")`);
    expect(code).toContain(`escapeMarker("td-h-2")`);
  });

  it("generates stable hydrate ids and records shorthand hydration strategies", () => {
    const result = compileTemplate(
      `<main><section hydrate><button>{label}</button></section><aside hydrate:visible="128px">{summary}</aside><footer hydrate:interaction="pointerenter">{status}</footer></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(
      `<main><section><button> </button></section><aside> </aside><footer> </footer></main>`,
    );
    expect(result.value.client.hydrationBoundaries).toEqual([
      { path: [0], id: "td-h-0", idKind: "static" },
      { path: [1], id: "td-h-1", idKind: "static", strategy: "visible", rootMargin: "128px" },
      { path: [2], id: "td-h-2", idKind: "static", strategy: "interaction", interaction: "pointerenter" },
    ]);
    expect(result.value.ir.directives).toContainEqual({
      kind: "hydrate",
      path: [1],
      id: "td-h-1",
      idKind: "static",
      strategy: "visible",
      rootMargin: "128px",
    });
    expect(renderServerTemplate(result.value, { label: "Buy", summary: "Ready", status: "Idle" })).toBe(
      `<main><!--tachyon-hydrate:td-h-0:start--><section><button>Buy</button></section><!--tachyon-hydrate:td-h-0:end--><!--tachyon-hydrate:td-h-1:start--><aside>Ready</aside><!--tachyon-hydrate:td-h-1:end--><!--tachyon-hydrate:td-h-2:start--><footer>Idle</footer><!--tachyon-hydrate:td-h-2:end--></main>`,
    );

    const code = generateServerStreamModule(result.value);
    expect(code).toContain(`escapeMarker("td-h-0")`);
    expect(code).toContain(`escapeMarker("td-h-1")`);
    expect(code).toContain(`escapeMarker("td-h-2")`);
  });

  it("renders outlet and named slots on server targets", () => {
    const result = compileTemplate(`<main><header><slot name="header"></slot></header><outlet></outlet></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(
      `<main><header><!--tachyon-slot:header--></header><!--tachyon-outlet--></main>`,
    );
    expect(
      renderServerTemplate(result.value, {
        outlet: `<section>Child</section>`,
        slots: { header: `<h1>Title</h1>` },
      }),
    ).toBe(`<main><header><h1>Title</h1></header><section>Child</section></main>`);

    const serverCode = generateServerModule(result.value);
    expect(serverCode).toContain(`String(scope.slots?.header ?? "")`);
    expect(serverCode).toContain(`String(scope.outlet ?? "")`);

    const streamCode = generateServerStreamModule(result.value);
    expect(streamCode).toContain(`__tachyonPush(String(scope.slots?.header ?? ""));`);
    expect(streamCode).toContain(`__tachyonPush(String(scope.outlet ?? ""));`);
  });

  it("generates bracket slot access for non-identifier slot names", () => {
    const result = compileTemplate(`<main><slot name="header-title"></slot></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(renderServerTemplate(result.value, { slots: { "header-title": "<h1>Title</h1>" } })).toBe(
      `<main><h1>Title</h1></main>`,
    );
    expect(generateServerModule(result.value)).toContain(`String(scope.slots?.["header-title"] ?? "")`);
    expect(generateServerStreamModule(result.value)).toContain(
      `__tachyonPush(String(scope.slots?.["header-title"] ?? ""));`,
    );
  });

  it("rejects component prop and store names that cannot become local bindings", () => {
    const propResult = compileTemplate(`<component name="Panel" data-x={value}><section>{value}</section></component>`);
    expect(propResult.ok).toBe(false);
    expect(propResult.ok ? "" : propResult.error.message).toBe("Invalid component prop binding name: data-x.");

    const storeResult = compileTemplate(`<main><store data-x={value}/><span>{value}</span></main>`);
    expect(storeResult.ok).toBe(false);
    expect(storeResult.ok ? "" : storeResult.error.message).toBe("Invalid store binding name: data-x.");
  });

  it("extracts keyed list boundaries for client code", () => {
    const result = compileTemplate(
      `<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td><td>{row.label}</td></tr></for></tbody>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe("<tbody></tbody>");
    expect(result.value.client.bindings).toEqual([
      {
        kind: "list",
        path: [],
        each: "rows",
        itemName: "row",
        key: "row.id",
        templateHtml: "<tr><td> </td><td> </td></tr>",
        bindings: [
          { kind: "text", path: [0, 0], expression: "row.id" },
          { kind: "text", path: [1, 0], expression: "row.label" },
        ],
      },
    ]);
  });

  it("carries row-local component, store, and hydration metadata", () => {
    const source = `<main><ul><for each={rows} key={row.id} as="row"><component name="Row" label={row.label}><li><store count={row.count}/><span hydrate:id={row.id}>{label}:{count}</span></li></component></for></ul></main>`;
    const result = compileTemplate(source);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const list = result.value.client.bindings.find((binding) => binding.kind === "list");
    expect(list).toMatchObject({
      kind: "list",
      components: [{ name: "Row", props: [{ name: "label", expression: "row.label" }] }],
      stores: [{ name: "count", initial: "row.count" }],
      hydrationBoundaries: [{ id: "row.id" }],
    });
    expect(generateClientModule(result.value)).toContain(`hydrationBoundaries`);
  });

  it("carries conditional-local stores, components, and hydration metadata", () => {
    const source = `<main><if test={visible}><component name="Panel" title={title}><section hydrate:id={boundaryId} hydrate:interaction="click"><span>{title}</span><store count={initial}/></section></component></if></main>`;
    const result = compileTemplate(source);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const conditional = result.value.client.bindings.find((binding) => binding.kind === "if");
    expect(conditional).toMatchObject({
      kind: "if",
      stores: [{ name: "count", initial: "initial" }],
      components: [{ name: "Panel", props: [{ name: "title", expression: "title" }] }],
      hydrationBoundaries: [
        { path: [], id: "boundaryId", idKind: "expression", strategy: "interaction", interaction: "click" },
      ],
    });
  });

  it("generates boundary chunks from the element the DOM path points at when stores precede it", () => {
    const result = compileTemplate(
      `<main><store name={"Ada"}/><input bind:value={name}><component name="Wrap"><section hydrate><store note={"x"}/><output>{name}</output></section></component></main>`,
    );
    if (!result.ok) throw new Error(result.error.message);
    const boundary = result.value.client.hydrationBoundaries[0];
    if (!boundary) throw new Error("Missing boundary.");
    const chunk = generateClientHydrationChunkModule(result.value, boundary.id, { reactive: true });

    expect(boundary.path).toEqual([1]);
    expect(chunk).toContain(`export const templateHtml = "<section><output> </output></section>";`);
    expect(chunk).toContain("__tachyonSetText");
    expect(chunk).toContain("__tachyonContext");
  });

  it("leaves bindings inside a nested boundary to that boundary's own chunk", () => {
    const result = compileTemplate(
      `<main><section hydrate:id="outer" hydrate:visible><div><p>{a}</p><div hydrate:id="inner" hydrate:interaction="click"><button on:click={go}>Go</button><span>{b}</span></div></div></section></main>`,
    );
    if (!result.ok) throw new Error(result.error.message);
    const [outer, inner] = result.value.client.hydrationBoundaries;
    if (!outer || !inner) throw new Error("Missing boundaries.");
    // The outer text shares the wrapper with the inner boundary, so only a full-prefix match may exclude it.
    expect(inner.path).toEqual([...outer.path, 0, 1]);

    const outerChunk = generateClientHydrationChunkModule(result.value, outer.id, { reactive: true });
    expect(outerChunk).toContain("scope.a");
    expect(outerChunk).not.toContain("scope.go");
    expect(outerChunk).not.toContain("scope.b");

    const innerChunk = generateClientHydrationChunkModule(result.value, inner.id, { reactive: true });
    expect(innerChunk).toContain("scope.go");
    expect(innerChunk).toContain("scope.b");
    expect(innerChunk).not.toContain("scope.a");
  });

  it("records template source spans for client bindings and allows instrumentation to be disabled", () => {
    const source = `<main><h1 class:on={active}>{ title }</h1><if test={show}><p>{note}</p></if><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></main>`;
    const result = compileTemplate(source);
    if (!result.ok) throw new Error(result.error.message);
    const [classBinding, textBinding, ifBinding, listBinding] = result.value.client.bindings;
    if (!classBinding || !textBinding || !ifBinding || !listBinding) throw new Error("Missing bindings.");

    const spanText = (binding: (typeof result.value.client.bindings)[number]): string | undefined => {
      const span = bindingSourceSpan(binding);
      return span ? source.slice(span.start, span.end) : undefined;
    };
    expect(spanText(classBinding)).toBe("active");
    expect(spanText(textBinding)).toBe("title");
    expect(spanText(ifBinding)).toBe("show");
    expect(spanText(listBinding)).toBe("rows");
    expect(bindingSourceSpan(textBinding)?.start).toBe(source.indexOf("title"));
    // Bindings inside the branch keep spans too.
    if (ifBinding.kind !== "if") throw new Error("Expected an if binding.");
    expect(spanText(ifBinding.bindings[0] as (typeof result.value.client.bindings)[number])).toBe("note");

    const plain = generateClientModule(result.value, { reactive: true, instrumentBindings: false });
    expect(plain).not.toContain("__tachyonRegisterBindings");
    expect(plain).not.toContain("__tachyonEnterBinding");

    const instrumented = generateClientModule(result.value, {
      reactive: true,
      templateId: "src/page.td",
      sourceRevision: "abcd1234",
      mapSourceOffset: (offset) => offset + 10,
    });
    expect(instrumented).toContain(
      `__tachyonRegisterBindings("src/page.td", "abcd1234", [[0, "class", [0], ${source.indexOf("active") + 10}, ${source.indexOf("active") + 16}], [1, "text", [0,0], ${source.indexOf("title") + 10}, ${source.indexOf("title") + 15}]`,
    );
    expect(instrumented).toContain(`__tachyonEnterBinding("src/page.td#abcd1234#3")`);
    expect(instrumented.match(/} finally \{/g)).toHaveLength(4);
  });

  it("rejects automatic row-local hydration ids that cannot be unique", () => {
    const source = `<ul><for each={rows} key={row.id}><li hydrate:idle>{row.label}</li></for></ul>`;
    const result = compileTemplate(source);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected row-local metadata diagnostic.");
    expect(result.error.message).toContain("hydrate:id");
    expect(result.error.offset).toBeGreaterThan(0);
  });

  it("keeps ordinary list bindings and top-level hydration metadata supported", () => {
    const result = compileTemplate(
      `<main hydrate:idle><ul><for each={rows} key={row.id}><li on:click={select} ref={rowRef}>{row.label}</li></for></ul></main>`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.client.hydrationBoundaries).toHaveLength(1);
    expect(result.value.client.bindings.some((binding) => binding.kind === "list")).toBe(true);
  });

  it("emits the opt-in reference update policy for immutable keyed rows", () => {
    const result = compileTemplate(
      `<ul><for each={rows} key={row.id} update="reference"><li>{row.label}</li></for></ul>`,
    );
    if (!result.ok) throw new Error(result.error.message);

    const binding = result.value.client.bindings.find((candidate) => candidate.kind === "list");
    expect(binding).toMatchObject({ kind: "list", updatePolicy: "reference" });
    expect(generateClientModule(result.value)).toContain(`updatePolicy: "reference"`);
  });

  it("emits a region contract when a keyed list has static siblings", () => {
    const result = compileTemplate(
      `<ul><li class="header">Header</li><for each={rows} key={row.id}><li>{row.label}</li></for><li class="footer">Footer</li></ul>`,
    );
    if (!result.ok) throw new Error(result.error.message);

    const list = result.value.client.bindings.find((binding) => binding.kind === "list");
    expect(list).toMatchObject({ kind: "list", region: { before: 1, after: 1 } });
    expect(generateClientModule(result.value)).toContain(`region: {"before":1,"after":1}`);
  });

  it.each([
    `<main><if test={visible}><p title={title}>{left}</p></if><p title="static">{tail}</p></main>`,
    `<main><if test={visible}><p class="shared" class:active={active}>{left}</p></if><p class="shared active">{tail}</p></main>`,
    `<main><if test={visible}><p title={title}>{left}</p></if><p title="static" on:click={save}>{tail}</p></main>`,
    `<main><if test={visible}><p title="same" class:active={active}>{left}</p></if><p title={title}>{tail}</p></main>`,
    `<main><if test={visible}><p class="active" title={title}>{left}</p></if><p class={classes} class:extra={active} title="static">{tail}</p></main>`,
  ])("diagnoses dynamic conditional shape overlap with a static sibling", (source) => {
    const result = compileTemplate(source);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.client.hydrationDynamicRegionErrors).toHaveLength(1);
    expect(result.value.client.hydrationDynamicRegionErrors[0]).toContain("dynamic attribute shape overlaps");
  });

  it.each([
    [
      `<main><if test={visible}><p class="active" title="static">{left}</p></if><p class:active={active} title="static">{tail}</p></main>`,
      1,
    ],
    [
      `<main><if test={visible}><p class="active" title={title}>{left}</p></if><p class={classes} class:extra={active} title="static">{tail}</p></main>`,
      1,
    ],
    [
      `<main><if test={visible}><p class="base active">{left}</p></if><p class="base" class:active={active}>{tail}</p></main>`,
      1,
    ],
    [`<main><if test={visible}><p class="active">{left}</p></if><p class:other={active}>{tail}</p></main>`, 0],
    [`<main><if test={visible}><p style="color:red">{left}</p></if><p style:color={color}>{tail}</p></main>`, 1],
    [`<main><if test={visible}><p style="color:red">{left}</p></if><p style:background={color}>{tail}</p></main>`, 0],
    [
      `<main><if test={visible}><p style="color:red">{left}</p></if><p style="color:blue" style:color={color}>{tail}</p></main>`,
      1,
    ],
    [
      `<main><if test={visible}><p class="base active">{left}</p></if><p class:base={active} class:active={active}>{tail}</p></main>`,
      1,
    ],
    [`<main><if test={visible}><p class="base active">{left}</p></if><p class:base={active}>{tail}</p></main>`, 0],
    [
      `<main><if test={visible}><p class="base active">{left}</p></if><p class="base extra" class:active={active}>{tail}</p></main>`,
      0,
    ],
    [
      `<main><if test={visible}><p style="color:red;background:blue">{left}</p></if><p style:color={color} style:background={background}>{tail}</p></main>`,
      1,
    ],
    [
      `<main><if test={visible}><p style="color:red;background:blue">{left}</p></if><p style:color={color}>{tail}</p></main>`,
      0,
    ],
    [
      `<main><if test={visible}><p style="color:red;background:blue">{left}</p></if><p style="color:green" style:background={background}>{tail}</p></main>`,
      0,
    ],
    [
      `<main><if test={visible}><p style="color:red;background:blue">{left}</p></if><p style="color:red" style:background={background}>{tail}</p></main>`,
      1,
    ],
    [`<main><if test={visible}><p class="active ">{left}</p></if><p class:active={active}>{tail}</p></main>`, 1],
    [
      `<main><if test={visible}><section><span>{left}</span><span class="active">{left}</span></section></if><section><span>{tail}</span><span class:active={active}>{tail}</span></section></main>`,
      1,
    ],
    [
      `<main><if test={visible}><section><span>{left}</span></section></if><section><span class:active={active}>{tail}</span><span>{tail}</span></section></main>`,
      0,
    ],
    [
      `<main><if test={visible}><section><span class="wrong">{left}</span><span class="active">{left}</span></section></if><section><span class="different">{tail}</span><span class:active={active}>{tail}</span></section></main>`,
      0,
    ],
    [
      `<main><if test={visible}><p class="label active" data-label="foo">{left}</p></if><p class:active={active} data-label="foo">{tail}</p></main>`,
      0,
    ],
    [
      `<main><if test={visible}><p class="active">{left}</p><span>{left}</span></if><p class:active={active}>{tail}</p></main>`,
      0,
    ],
    [
      `<main><if test={visible}><p style="color: red; background: blue">{left}</p></if><p style="color: red" style:background={background}>{tail}</p></main>`,
      1,
    ],
  ])("matches generated class and style attributes against conditional siblings %#", (source, expectedErrors) => {
    const result = compileTemplate(source);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.client.hydrationDynamicRegionErrors).toHaveLength(expectedErrors);
  });

  it("keeps direct text children out of dynamic region classification", () => {
    const result = compileTemplate(`<main>prefix<if test={visible}><span>{left}</span></if></main>`);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.client.hydrationDynamicRegionErrors).toHaveLength(0);
  });

  it("preserves nested dynamic-region diagnostic paths and reasons", () => {
    const rootConditional = compileTemplate(
      `<main><if test={visible}><p title={title}>{left}</p></if><p title="static">{tail}</p></main>`,
    );
    if (!rootConditional.ok) throw new Error(rootConditional.error.message);
    expect(rootConditional.value.client.hydrationDynamicRegionErrors[0]).toContain("at root:");

    const nestedConditional = compileTemplate(
      `<main><section><if test={visible}><p title={title}>{left}</p></if><p title="static">{tail}</p></section></main>`,
    );
    if (!nestedConditional.ok) throw new Error(nestedConditional.error.message);
    expect(nestedConditional.value.client.hydrationDynamicRegionErrors[0]).toContain("at root.0:");
    expect(nestedConditional.value.client.hydrationDynamicRegionErrors[0]).toContain(
      "its dynamic attribute shape overlaps another sibling.",
    );

    const deeplyNestedConditional = compileTemplate(
      `<main><section><article><if test={visible}><p title={title}>{left}</p></if><p title="static">{tail}</p></article></section></main>`,
    );
    if (!deeplyNestedConditional.ok) throw new Error(deeplyNestedConditional.error.message);
    expect(deeplyNestedConditional.value.client.hydrationDynamicRegionErrors[0]).toContain("at root.0.0:");

    const nestedList = compileTemplate(
      `<main><section><for each={rows} key={row.id}><p>{row.label}</p></for><if test={visible}><span>{left}</span></if></section></main>`,
    );
    if (!nestedList.ok) throw new Error(nestedList.error.message);
    expect(nestedList.value.client.hydrationDynamicRegionErrors[0]).toContain("at root.0");

    const deeplyNestedList = compileTemplate(
      `<main><section><article><for each={rows} key={row.id}><p>{row.label}</p></for><if test={visible}><span>{left}</span></if></article></section></main>`,
    );
    if (!deeplyNestedList.ok) throw new Error(deeplyNestedList.error.message);
    expect(deeplyNestedList.value.client.hydrationDynamicRegionErrors[0]).toContain("at root.0.0");

    const rootList = compileTemplate(
      `<main><for each={rows} key={row.id}><p>{row.label}</p></for><if test={visible}><span>{left}</span></if></main>`,
    );
    if (!rootList.ok) throw new Error(rootList.error.message);
    expect(rootList.value.client.hydrationDynamicRegionErrors[0]).toContain("at root when");

    const sharedShape = compileTemplate(
      `<main><if test={visible}><p class="shared">{left}</p></if><p class="shared">{tail}</p></main>`,
    );
    if (!sharedShape.ok) throw new Error(sharedShape.error.message);
    expect(sharedShape.value.client.hydrationDynamicRegionErrors[0]).toContain(
      "its client shape is shared by another sibling.",
    );
  });

  it("requires every child in a generated-attribute sibling shape to match", () => {
    const result = compileTemplate(
      `<main><if test={visible}><section><span>{left}</span><span class="wrong">{left}</span></section></if><section><span>{tail}</span><span class:active={active}>{tail}</span></section></main>`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.client.hydrationDynamicRegionErrors).toHaveLength(0);
  });

  it("applies list path correction only after a static prefix and composes it with conditional paths", () => {
    const withSiblings = compileTemplate(
      `<main><header>{head}</header><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`,
    );
    if (!withSiblings.ok) throw new Error(withSiblings.error.message);
    const siblingCode = generateClientModule(withSiblings.value, { reactive: true, instrumentBindings: false });

    expect(siblingCode).toContain(`__tachyonTextAt(root, [0,0])`);
    expect(siblingCode).not.toContain(`__tachyonNodeAtWithDynamicLists(root, [0,0]`);
    expect(siblingCode).toContain(`__tachyonNodeAtWithDynamicLists(root, [1,0]`);

    const withConditional = compileTemplate(
      `<main><section><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></section><aside><if test={visible}><b>{head}</b></if></aside></main>`,
    );
    if (!withConditional.ok) throw new Error(withConditional.error.message);
    const conditionalCode = generateClientModule(withConditional.value, { reactive: true, instrumentBindings: false });

    expect(conditionalCode).toContain(
      `dynamicListChildOffset as __tachyonDynamicListChildOffset, nodeAtWithDynamicLists as __tachyonNodeAtWithDynamicLists`,
    );
    expect(conditionalCode).toContain(
      `__tachyonPreparedNodeAt(root, [0,0,0], (container, parentPath, childIndex) => __tachyonDynamicListChildOffset`,
    );

    const withTextPrefix = compileTemplate(
      `<main>intro<header>{head}</header><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`,
    );
    if (!withTextPrefix.ok) throw new Error(withTextPrefix.error.message);
    const textPrefixList = withTextPrefix.value.client.bindings.find((binding) => binding.kind === "list");
    expect(textPrefixList).toMatchObject({ kind: "list", region: { before: 1, after: 1, logicalBefore: 2 } });
    const textPrefixCode = generateClientModule(withTextPrefix.value, { reactive: true, instrumentBindings: false });
    expect(textPrefixCode).toContain(`region: {"before":1,"after":1,"logicalBefore":2}`);

    const withTextComponent = compileTemplate(
      `<main><component name="Prefix">intro{prefix}</component><header>{head}</header><for each={rows} key={row.id}><p>{row.label}</p></for><footer>{tail}</footer></main>`,
    );
    if (!withTextComponent.ok) throw new Error(withTextComponent.error.message);
    const textComponentList = withTextComponent.value.client.bindings.find((binding) => binding.kind === "list");
    expect(textComponentList).toMatchObject({ kind: "list", region: { before: 1, after: 1, logicalBefore: 4 } });

    const withTextOnlySiblings = compileTemplate(
      `<main>{head}<for each={rows} key={row.id}><p>{row.label}</p></for>{tail}</main>`,
    );
    if (!withTextOnlySiblings.ok) throw new Error(withTextOnlySiblings.error.message);
    const textOnlyList = withTextOnlySiblings.value.client.bindings.find((binding) => binding.kind === "list");
    expect(textOnlyList).toMatchObject({
      kind: "list",
      region: { before: 0, after: 0, logicalBefore: 1, logicalAfter: 1 },
    });
    expect(generateClientModule(withTextOnlySiblings.value, { reactive: true, instrumentBindings: false })).toContain(
      `region: {"before":0,"after":0,"logicalBefore":1,"logicalAfter":1}`,
    );

    const withComponentList = compileTemplate(
      `<main><header>{head}</header><component name="Rows"><for each={rows} key={row.id}><p>{row.label}</p></for></component><footer>{tail}</footer></main>`,
    );
    if (!withComponentList.ok) throw new Error(withComponentList.error.message);
    const componentList = withComponentList.value.client.bindings.find((binding) => binding.kind === "list");
    expect(componentList).toMatchObject({
      kind: "list",
      path: [],
      region: { before: 1, after: 1 },
    });
  });

  it("renders keyed lists on the server", () => {
    const result = compileTemplate(
      `<tbody><for each={rows} key={row.id}><tr class:danger={row.selected}><td>{row.id}</td><td>{row.label}</td></tr></for></tbody>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(
      renderServerTemplate(result.value, {
        rows: [
          { id: 1, label: "One", selected: false },
          { id: 2, label: "<Two>", selected: true },
        ],
      }),
    ).toBe(`<tbody><tr><td>1</td><td>One</td></tr><tr class="danger"><td>2</td><td>&lt;Two&gt;</td></tr></tbody>`);
  });

  it("uses the text-only list runtime when every row binding is text", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`mountGeneratedTextKeyedList as __tachyonMountTextKeyedList`);
    expect(code).toContain(`cleanupTextKeyedList as __tachyonCleanupTextKeyedList`);
    expect(code).toContain(`from "tachyon-dom/runtime/list-text"`);
    expect(code).not.toContain(`from "tachyon-dom/runtime/list"`);
    expect(code).toContain(`const __tachyonTarget0 = root;`);
    expect(code).toContain(`__tachyonMountTextKeyedList(__tachyonTarget0, [], scope.rows`);
    expect(code).toContain(`cleanups.push(() => __tachyonCleanupTextKeyedList(__tachyonTarget0, []))`);
    expect(code).toContain(`key: "row.id"`);
    expect(code).toContain(`itemName: "row"`);
  });

  it("drives text, class, attribute, and event rows with the generated list adapter", () => {
    const result = compileTemplate(
      `<ul><for each={rows} key={row.id}><li title={row.label} class:on={row.on} on:click={select}>{row.label}</li></for></ul>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`mountGeneratedTextKeyedList as __tachyonMountTextKeyedList`);
    expect(code).not.toContain(`from "tachyon-dom/runtime/list"`);
    expect(code).toContain(`from "tachyon-dom/runtime/list-text"`);
    // The setters come from this module, so the adapter itself imports none of them.
    expect(code).toContain(`apply: (node, value) => __tachyonSetAttributeValue(node, "title", value)`);
    expect(code).toContain(`apply: (node, value) => __tachyonSetClassPresence(node, "on", value)`);
    // The handler is looked up when the event fires, not when the listener is registered.
    expect(code).toContain(
      `bind: (element, scope) => __tachyonDelegate(element, "click", [], (event) => { const handler = scope.select; if (typeof handler === "function") handler(event); })`,
    );
  });

  it("keeps rows the adapter cannot drive on the generic list runtime", () => {
    for (const source of [
      `<ul><for each={rows} key={row.id}><li style:opacity={row.opacity}>{row.label}</li></for></ul>`,
      `<ul><for each={rows} key={row.id}><li ref={refs.row}>{row.label}</li></for></ul>`,
      `<ul><for each={rows} key={row.id}><li><input bind:value={row.draft}></li></for></ul>`,
      `<ul><for each={rows} key={row.id}><li on:click={select}></li></for></ul>`,
    ]) {
      const result = compileTemplate(source);
      if (!result.ok) throw new Error(result.error.message);
      const code = generateClientModule(result.value);

      expect([source, code.includes(`from "tachyon-dom/runtime/list"`)]).toEqual([source, true]);
      expect([source, code.includes(`from "tachyon-dom/runtime/list-text"`)]).toEqual([source, false]);
    }
  });

  // Whichever runtime drives the row, a dynamic URL attribute is written through the sanitizing setter.
  it.each([
    ["dynamic href", `<ul><for each={rows} key={row.id}><li><a href={row.url}>{row.label}</a></li></for></ul>`, "href"],
    ["dynamic srcset", `<ul><for each={rows} key={row.id}><li><img srcset={row.sources}></li></for></ul>`, "srcset"],
    [
      "dynamic formaction",
      `<ul><for each={rows} key={row.id}><li><button formaction={row.action}>{row.label}</button></li></for></ul>`,
      "formaction",
    ],
  ])("writes %s row bindings through the security-aware attribute setter", (_name, source, attribute) => {
    const result = compileTemplate(source);
    if (!result.ok) throw new Error(result.error.message);

    const code = generateClientModule(result.value);

    expect(code).toContain(`__tachyonSetAttributeValue(node, ${JSON.stringify(attribute)}, value)`);
    expect(code).toContain(`from "tachyon-dom/runtime/attr"`);
  });

  it.each([
    [
      "nested list",
      `<ul><for each={groups} key={group.id}><li>{group.label}<ul><for each={group.rows} key={row.id}><li>{row.label}</li></for></ul></li></for></ul>`,
    ],
    [
      "nested conditional",
      `<ul><for each={rows} key={row.id}><li>{row.label}<if test={row.visible}><span>{row.note}</span></if></li></for></ul>`,
    ],
  ])("keeps %s row bindings on the generic runtime", (_name, source) => {
    const result = compileTemplate(source);
    if (!result.ok) throw new Error(result.error.message);

    const code = generateClientModule(result.value);

    expect(code).toContain(`from "tachyon-dom/runtime/list"`);
    expect(code).not.toContain(`from "tachyon-dom/runtime/list-text"`);
  });

  it("captures a nested text-only list container for cleanup after DOM removal", () => {
    const result = compileTemplate(`<main><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></main>`);
    if (!result.ok) throw new Error(result.error.message);

    const code = generateClientModule(result.value);

    expect(code).toContain(`const __tachyonTarget0 = __tachyonElementAt(root, [0]);`);
    expect(code).toContain(`__tachyonMountTextKeyedList(__tachyonTarget0, [], scope.rows`);
    expect(code).toContain(`__tachyonCleanupTextKeyedList(__tachyonTarget0, [])`);
    expect(code).not.toContain(`__tachyonCleanupTextKeyedList(root, [0])`);
  });

  it("generates item-direct key readers for simple list keys", () => {
    const result = compileTemplate(`<tbody><for each={rows} key={row.id}><tr><td>{row.id}</td></tr></for></tbody>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`keyReadItem: (row) => row.id`);
    expect(code).not.toContain(`keyRead: (scope) => scope.row.id`);
  });

  it("generates compiled list binding readers instead of runtime dot parsing", () => {
    const result = compileTemplate(
      `<ul><for each={rows} key={row.ids[0]}><li>{row.profile?.name ?? row.name}</li></for></ul>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value);

    expect(code).toContain(`const listOptions0 = {`);
    expect(code).toContain(`keyRead: (scope) => ((__tachyonObject, __tachyonProperty) =>`);
    expect(code).toContain(`__tachyonObject[__tachyonProperty])(scope.row.ids, 0)`);
    expect(code).toContain(`read: (scope) => (scope.row.profile?.name ?? scope.row.name)`);
    expect(code).toContain(`__tachyonMountTextKeyedList(__tachyonTarget0, [], scope.rows, listOptions0)`);
  });

  it("caches reactive list containers and conditional anchors before effects", () => {
    const result = compileTemplate(
      `<main><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul><if test={active}><p>{label}</p></if></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateClientModule(result.value, { reactive: true });

    expect(code).not.toContain(`nodeAt as __tachyonNodeAt`);
    expect(code).toContain(`const __tachyonTarget`);
    expect(code).toContain(`__tachyonMountTextKeyedList(__tachyonTarget`);
    expect(code).toContain(`__tachyonMountGeneratedConditionalCore(root, [1]`);
    expect(code).toContain(
      `__tachyonMountGeneratedConditionalCore(root, [1], __tachyonConditionalVisibility0(), scope, conditionalOptions`,
    );
    expect(code).not.toContain(`__tachyonMountTextKeyedList(root, [0]`);
    expect(code).not.toContain(`__tachyonMountGeneratedConditional(root, [1]`);
  });

  it("fixes the HTML-first syntax surface in an explicit IR", () => {
    const result = compileTemplate(
      `<main><store count={initialCount}/><component name="CounterPanel"><section hydrate:id={islandId}><if test={active}><button on:click={increment}>{count}</button></if><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></section></component></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.ir.directives).toEqual([
      { kind: "store", path: [0], stores: [{ name: "count", initial: "initialCount" }] },
      { kind: "component", path: [1], name: "CounterPanel", props: [], stores: [] },
      { kind: "hydrate", path: [1], id: "islandId", idKind: "expression" },
      { kind: "if", path: [1, 0], test: "active" },
      { kind: "event", path: [1, 0, 0], eventName: "click", handler: "increment" },
      { kind: "for", path: [1, 1, 0], each: "rows", key: "row.id", itemName: "row" },
    ]);
  });

  it("lowers conditional rendering and transparent component boundaries to client and server targets", () => {
    const result = compileTemplate(
      `<main><component name="Panel"><section><if test={active}><button on:click={increment}>{count}</button></if></section></component></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.client.templateHtml).toBe(`<main><section><!----></section></main>`);
    expect(result.value.client.bindings).toEqual([
      {
        kind: "if",
        path: [0, 0],
        test: "active",
        templateHtml: "<button> </button>",
        bindings: [
          { kind: "event", path: [], eventName: "click", handler: "increment" },
          { kind: "text", path: [0], expression: "count" },
        ],
      },
    ]);
    expect(renderServerTemplate(result.value, { active: true, count: 3 })).toBe(
      `<main><section><button>3</button></section></main>`,
    );
    expect(renderServerTemplate(result.value, { active: false, count: 3 })).toBe(`<main><section></section></main>`);

    const code = generateClientModule(result.value, { reactive: true });
    expect(code).toContain(`from "tachyon-dom/runtime/conditional-core"`);
    expect(code).toContain(`const conditionalOptions0 = {`);
    expect(code).toContain(
      `__tachyonMountGeneratedConditionalCore(root, [0,0], __tachyonConditionalVisibility0(), scope, conditionalOptions0)`,
    );
  });

  it("rejects unsupported syntax before target generation", () => {
    const cases = [
      [`<ul><for key={row.id}><li>{row.label}</li></for></ul>`, "<for> requires each={items}."],
      [`<ul><for each={rows}><li>{row.label}</li></for></ul>`, "<for> requires key={item.id}."],
      [`<section><if><button>Save</button></if></section>`, "<if> requires test={condition}."],
      [
        `<main><section hydrate:id={islandId}></section><section hydrate:id={islandId}></section></main>`,
        "Duplicate hydrate boundary id expression: islandId.",
      ],
      [`<input bind:value={count + 1}></input>`, "bind:value requires an assignable expression."],
      [
        `<component name="Panel"><h1>One</h1><p>Two</p></component>`,
        "<component> requires exactly one renderable root child.",
      ],
      [`<main><await then="message"><p>{message}</p></await></main>`, "<await> requires value={promise}."],
      [`<main><await value={messagePromise}><p>{message}</p></await></main>`, `<await> requires then="name".`],
    ] as const;

    for (const [source, message] of cases) {
      const result = compileTemplate(source);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected compiler error.");
      }
      expect(result.error.message).toBe(message);
    }
  });

  it("renders component props and local stores on server targets", () => {
    const result = compileTemplate(
      `<component name="Panel" label={title} initial={initialCount}><section><store count={initial}/><h1>{label}</h1><button>{count}</button><component name="Nested" value={label}><p>{value}</p></component></section></component>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.ir.directives).toContainEqual({
      kind: "component",
      path: [],
      name: "Panel",
      props: [
        { name: "label", expression: "title" },
        { name: "initial", expression: "initialCount" },
      ],
      stores: [{ name: "count", initial: "initial" }],
    });
    expect(result.value.client.components).toEqual([
      {
        path: [],
        name: "Panel",
        props: [
          { name: "label", expression: "title" },
          { name: "initial", expression: "initialCount" },
        ],
        stores: [{ name: "count", initial: "initial" }],
      },
      {
        path: [2],
        name: "Nested",
        props: [{ name: "value", expression: "label" }],
        stores: [],
      },
    ]);
    expect(renderServerTemplate(result.value, { title: "Hello", initialCount: 4 })).toBe(
      `<section><h1>Hello</h1><button>4</button><p>Hello</p></section>`,
    );

    const code = generateServerModule(result.value);
    expect(code).toContain(`const label = scope.title;`);
    expect(code).toContain(`const count = initial;`);
    expect(code).toContain(`const value = label;`);

    const clientCode = generateClientModule(result.value);
    expect(clientCode).toContain(`export const componentBoundaries = [{"path":[],"name":"Panel"`);
  });

  it("generates await fragments for the streaming server target", async () => {
    const result = compileTemplate(
      `<main><h1>Before</h1><await value={messagePromise} then="message"><p>{message}</p></await></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerStreamModule(result.value);
    expect(code).toContain(`const message = await scope.messagePromise;`);

    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      stream: (scope: { messagePromise: Promise<string> }) => AsyncIterable<string>;
    };
    const chunks: string[] = [];
    for await (const chunk of module.stream({ messagePromise: Promise.resolve("Ready") })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe(`<main><h1>Before</h1><p>Ready</p></main>`);
  });

  it("keeps the generated synchronous await fallback when its child is empty", async () => {
    const result = compileTemplate(`<main><await value={messagePromise} then="message"></await></main>`);
    if (!result.ok) throw new Error(result.error.message);

    const code = generateServerModule(result.value);
    expect(code).toContain(`((message) => "")(scope.messagePromise)`);

    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      render: (scope: { messagePromise: unknown }) => string;
    };
    expect(module.render({ messagePromise: "Ready" })).toBe(`<main></main>`);
  });

  it("generates hydration state helpers for server modules", async () => {
    const result = compileTemplate(`<main><section hydrate:id={islandId}>{label}</section></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const code = generateServerModule(result.value);

    expect(code).toContain(`export const hydrationBoundaries = [{"path":[0],"id":"islandId","idKind":"expression"}];`);
    expect(code).toContain(`export const renderHydrationState = (id, state) =>`);

    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      renderHydrationState: (id: string, state: unknown) => string;
    };
    const stateHtml = module.renderHydrationState("island", { body: `</script><img src=x onerror=alert(1)>` });
    expect(stateHtml).toContain(String.raw`\u003c/script\u003e\u003cimg`);
    expect(stateHtml).not.toContain(`</script><img`);
  });

  it("records await streaming options and emits fallback and error chunks", async () => {
    const result = compileTemplate(
      `<main><await value={messagePromise} then="message" fallback="Loading" error="Failed" reorder="preserve"><p>{message}</p></await></main>`,
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value.ir.directives).toContainEqual({
      kind: "await",
      path: [0],
      value: "messagePromise",
      thenName: "message",
      fallback: "Loading",
      error: "Failed",
      reorder: "preserve",
    });

    const code = generateServerStreamModule(result.value);
    expect(code).toContain(`__tachyonPush("Loading");`);
    expect(code).toContain(`} catch {`);
    expect(code).toContain(`__tachyonPush("Failed");`);

    const module = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
      stream: (scope: { messagePromise: Promise<string> }) => AsyncIterable<string>;
    };
    const successChunks: string[] = [];
    for await (const chunk of module.stream({ messagePromise: Promise.resolve("Ready") })) {
      successChunks.push(chunk);
    }
    expect(successChunks.join("")).toBe(`<main>Loading<p>Ready</p></main>`);

    const errorChunks: string[] = [];
    for await (const chunk of module.stream({ messagePromise: Promise.reject(new Error("Nope")) })) {
      errorChunks.push(chunk);
    }
    expect(errorChunks.join("")).toBe(`<main>LoadingFailed</main>`);
  });

  it("rejects resolve-order await fragments in the streaming target", () => {
    const result = compileTemplate(
      `<main><await value={messagePromise} then="message" reorder="resolve"><p>{message}</p></await></main>`,
    );
    if (!result.ok) throw new Error(result.error.message);

    expect(() => generateServerStreamModule(result.value)).toThrow(
      '<await reorder="resolve"> is not supported by the stream target',
    );
  });
});
