import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  generateServerModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../src/compiler";

const importModule = async <T>(code: string): Promise<T> =>
  (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as T;

const compile = (source: string) => {
  const result = compileTemplate(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("<await> target contracts", () => {
  const template = `<main><await value={messagePromise} then="message"><p>{message}</p></await></main>`;

  it("renders a resolved value through the synchronous server renderer", () => {
    expect(renderServerTemplate(compile(template), { messagePromise: "Ready" })).toBe(`<main><p>Ready</p></main>`);
  });

  it("rejects a Promise in the synchronous server renderer instead of rendering it as text", () => {
    expect(() => renderServerTemplate(compile(template), { messagePromise: Promise.resolve("Ready") })).toThrow(
      /<await> received a Promise in the synchronous server target/,
    );
  });

  it("rejects a Promise in the generated synchronous server module", async () => {
    const module = await importModule<{ render: (scope: Record<string, unknown>) => string }>(
      generateServerModule(compile(template)),
    );
    expect(module.render({ messagePromise: "Ready" })).toBe(`<main><p>Ready</p></main>`);
    expect(() => module.render({ messagePromise: Promise.resolve("Ready") })).toThrow(
      /<await> received a Promise in the synchronous server target/,
    );
  });

  it("lowers <await> to a marker without bindings in the client target", () => {
    const compiled = compile(template);
    expect(compiled.client.templateHtml).toBe(`<main><!--tachyon-await--></main>`);
    expect(compiled.client.bindings).toEqual([]);
  });

  it("does not emit the await guard when a template has no <await>", () => {
    expect(generateServerModule(compile(`<main>{label}</main>`))).not.toContain("awaitValue");
  });

  it("accepts pending= as the documented name for the HTML yielded before awaiting", async () => {
    const compiled = compile(
      `<main><await value={messagePromise} then="message" pending="<p>Loading</p>"><p>{message}</p></await></main>`,
    );
    expect(compiled.ir.directives).toContainEqual(
      expect.objectContaining({ kind: "await", pending: "<p>Loading</p>", fallback: "<p>Loading</p>" }),
    );
    const module = await importModule<{ stream: (scope: Record<string, unknown>) => AsyncIterable<string> }>(
      generateServerStreamModule(compiled),
    );
    const chunks: string[] = [];
    for await (const chunk of module.stream({ messagePromise: Promise.resolve("Ready") })) chunks.push(chunk);
    // The pending HTML is appended output, not a placeholder that gets replaced.
    expect(chunks.join("")).toBe(`<main><p>Loading</p><p>Ready</p></main>`);
  });

  it("keeps fallback= as an alias of pending=", () => {
    const compiled = compile(
      `<main><await value={messagePromise} then="message" fallback="Loading"><p>{message}</p></await></main>`,
    );
    expect(compiled.ir.directives).toContainEqual(
      expect.objectContaining({ kind: "await", pending: "Loading", fallback: "Loading" }),
    );
  });

  it("rejects pending= and fallback= used together", () => {
    const result = compileTemplate(
      `<main><await value={p} then="m" pending="A" fallback="B"><p>{m}</p></await></main>`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("pending");
  });
});
