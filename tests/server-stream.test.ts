import { describe, expect, it } from "vitest";
import {
  compileTemplate,
  generateServerModule,
  generateServerStreamModule,
  renderServerTemplate,
} from "../src/compiler";
import { renderToReadableStream, renderToResponse } from "../src/server/stream";

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const result = await reader.read();
    if (result.done) {
      return output;
    }
    output += decoder.decode(result.value, { stream: true });
  }
};

async function* delayedChunks(): AsyncIterable<string> {
  yield "<main>";
  await Promise.resolve();
  yield "<section>ready</section>";
  yield "</main>";
}

describe("server stream adapter", () => {
  it("coalesces synchronous iterable chunks", async () => {
    const stream = renderToReadableStream(["<h1>", "Hello", "</h1>"]);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    const second = await reader.read();

    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("<h1>Hello</h1>");
    expect(second.done).toBe(true);
  });

  it("flushes before unresolved async boundaries", async () => {
    let resolveLate!: () => void;
    const late = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    async function* chunks(): AsyncIterable<string> {
      yield "<main>";
      await late;
      yield "<section>late</section>";
    }

    const reader = renderToReadableStream(chunks()).getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("<main>");

    resolveLate();
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(decoder.decode(second.value)).toBe("<section>late</section>");
  });

  it("adapts async chunks into an HTML response", async () => {
    const response = renderToResponse(delayedChunks());

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(await readStream(response.body as ReadableStream<Uint8Array>)).toBe("<main><section>ready</section></main>");
  });

  it("returns async chunk sources when stream readers cancel", async () => {
    let cancelled = false;
    async function* cancellableChunks(): AsyncIterable<string> {
      try {
        yield "<main>";
        await new Promise(() => undefined);
      } finally {
        cancelled = true;
      }
    }

    const reader = renderToReadableStream(cancellableChunks()).getReader();
    expect(await reader.read()).toMatchObject({ done: false });
    await reader.cancel();

    expect(cancelled).toBe(true);
  });

  it("coalesces synchronous chunks emitted by the generated stream target", async () => {
    const result = compileTemplate(`<main><h1>{title}</h1><p>Ready</p></main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const module = generateServerStreamModule(result.value).replace("export const stream", "const stream");
    expect(module).toContain("new TextEncoder");
    expect(module).toContain("__tachyonBufferBytes += __tachyonTextEncoder.encode(text).byteLength");
    const stream = new Function(`${module}; return stream;`)() as (
      scope: Record<string, unknown>,
    ) => AsyncIterable<string>;
    const chunks: string[] = [];

    for await (const chunk of stream({ title: "Hello" })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["<main><h1>Hello</h1><p>Ready</p></main>"]);
  });

  it("keeps explicit for item and index aliases in stream output", async () => {
    const result = compileTemplate(
      `<ul><for each={items} as="item" index="index" key={item.id}><li>{index}:{item.name}</li></for></ul>`,
    );
    if (!result.ok) throw new Error(result.error.message);
    const module = generateServerStreamModule(result.value).replace("export const stream", "const stream");
    const stream = new Function(`${module}; return stream;`)() as (
      scope: Record<string, unknown>,
    ) => AsyncIterable<string>;
    const chunks: string[] = [];

    for await (const chunk of stream({ items: [{ id: 1, name: "Alice" }] })) {
      chunks.push(chunk);
    }

    expect(chunks.join("").replaceAll("<!---->", "")).toBe(`<ul><li>0:Alice</li></ul>`);
  });

  it("keeps a text-only list boundary in generated stream output", async () => {
    const result = compileTemplate(`<main>{head}<for each={rows} key={row.id}><p>{row.label}</p></for>{tail}</main>`);
    if (!result.ok) throw new Error(result.error.message);
    const module = generateServerStreamModule(result.value).replace("export const stream", "const stream");
    const stream = new Function(`${module}; return stream;`)() as (
      scope: Record<string, unknown>,
    ) => AsyncIterable<string>;
    const chunks: string[] = [];

    for await (const chunk of stream({ head: "H", rows: [{ id: 1, label: "A" }], tail: "F" })) {
      chunks.push(chunk);
    }

    expect(chunks.join("").replaceAll("<!---->", "")).toBe(`<main>H<p>A</p><!--tachyon-list-->F</main>`);
  });

  it.each([0, 1, 2])("keeps a list boundary in generated synchronous SSR inside await for %i rows", async (count) => {
    const result = compileTemplate(
      `<main><await value={rows} then="resolved"><for each={resolved} key={row.id}><p>{row.label}</p></for>{tail}</await></main>`,
    );
    if (!result.ok) throw new Error(result.error.message);
    const server = await import(
      `data:text/javascript;base64,${Buffer.from(generateServerModule(result.value)).toString("base64")}`
    );
    const streamServer = await import(
      `data:text/javascript;base64,${Buffer.from(generateServerStreamModule(result.value)).toString("base64")}`
    );
    const rows = Array.from({ length: count }, (_, index) => ({ id: index, label: `R${index}` }));
    const scope = { rows, tail: "F" };
    const generated = server.render(scope);
    const direct = renderServerTemplate(result.value, scope);
    let streamed = "";
    for await (const chunk of streamServer.stream(scope)) streamed += chunk;

    expect(generated).toBe(direct);
    expect(streamed).toBe(direct);
    expect(generated.match(/<!--tachyon-list-->/g)).toHaveLength(1);
    expect(generated.indexOf("<!--tachyon-list-->")).toBeLessThan(generated.indexOf("F"));
  });

  it("flushes generated stream chunks at the byte threshold even without await boundaries", async () => {
    const result = compileTemplate(`<main>${"<p>Ready</p>".repeat(900)}</main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const module = generateServerStreamModule(result.value).replace("export const stream", "const stream");
    const stream = new Function(`${module}; return stream;`)() as (
      scope: Record<string, unknown>,
    ) => AsyncIterable<string>;
    const chunks: string[] = [];

    for await (const chunk of stream({})) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(`<main>${"<p>Ready</p>".repeat(900)}</main>`);
  });

  it("flushes generated stream chunks by UTF-8 byte length for CJK text", async () => {
    const text = "漢".repeat(3000);
    const result = compileTemplate(`<main>${text}</main>`);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const module = generateServerStreamModule(result.value).replace("export const stream", "const stream");
    const stream = new Function(`${module}; return stream;`)() as (
      scope: Record<string, unknown>,
    ) => AsyncIterable<string>;
    const chunks: string[] = [];

    for await (const chunk of stream({})) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(`<main>${text}</main>`);
  });
});
