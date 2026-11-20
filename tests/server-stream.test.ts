import { describe, expect, it, vi } from "vitest";
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

const readByteChunks = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(result.value);
  }
};

const readTextChunks = async (stream: AsyncIterable<string>): Promise<string[]> => {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
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

  it.each([
    ["adapter", "ascii", "at"],
    ["generated", "ascii", "at"],
    ["adapter", "paired", "below"],
    ["generated", "paired", "beyond"],
    ["adapter", "unpaired", "at"],
    ["generated", "unpaired", "below"],
    ["adapter", "ascii", "below"],
    ["adapter", "three", "beyond"],
    ["generated", "three", "below"],
    ["generated", "ascii", "beyond"],
    ["generated", "two", "at"],
    ["adapter", "two", "below"],
    ["generated", "two", "beyond"],
    ["adapter", "paired", "at"],
    ["generated", "three", "at"],
    ["generated", "unpaired", "beyond"],
  ] as const)("preserves %s flush boundaries for %s code units %s the target", async (entry, units, boundary) => {
    const sample = { ascii: "a", two: "π", three: "漢", paired: "🚀", unpaired: "\uD800x\uDC00" }[units];
    const offset = { below: -1, at: 0, beyond: 5 }[boundary];
    const encoder = new TextEncoder();
    const prefix = "<main>";
    const suffix = "</main>";
    const payload = "x".repeat(8192 + offset - prefix.length - encoder.encode(sample).byteLength) + sample;
    const expected = boundary === "below" ? [prefix + payload + suffix] : [prefix + payload, suffix];
    if (entry === "adapter") {
      const chunks = await readByteChunks(renderToReadableStream([prefix, payload, suffix]));
      expect(chunks).toEqual(expected.map((part) => encoder.encode(part)));
    } else {
      const result = compileTemplate("<main>{value}</main>");
      if (!result.ok) throw new Error(result.error.message);
      const code = generateServerStreamModule(result.value).replace("export const stream", "const stream");
      const stream = new Function(`${code}; return stream;`)() as (
        scope: Record<string, unknown>,
      ) => AsyncIterable<string>;
      expect(await readTextChunks(stream({ value: payload }))).toEqual(expected);
    }
  });

  it("counts split surrogate chunks individually and encodes their concatenation", async () => {
    const prefix = "x".repeat(8186);
    const encoder = new TextEncoder();
    const chunks = await readByteChunks(renderToReadableStream([prefix, "\uD83D", "\uDE80", "end"]));
    expect(chunks).toEqual([encoder.encode(prefix + "🚀"), encoder.encode("end")]);
  });

  it.each(["adapter", "generated"] as const)(
    "skips measurement encoding for ASCII and for chunks guaranteed to flush in the %s",
    async (entry) => {
      const prefix = "<main>";
      const suffix = "</main>";
      const value = "漢".repeat(8192 - prefix.length);
      const result = compileTemplate("<main>{value}</main>");
      if (!result.ok) throw new Error(result.error.message);
      const code = generateServerStreamModule(result.value).replace("export const stream", "const stream");
      const stream = new Function(`${code}; return stream;`)() as (
        scope: Record<string, unknown>,
      ) => AsyncIterable<string>;
      const encode = vi.spyOn(TextEncoder.prototype, "encode");
      try {
        if (entry === "adapter") {
          await readByteChunks(renderToReadableStream([prefix, value, suffix]));
          expect(encode).toHaveBeenCalledTimes(2);
          expect(encode.mock.calls[0]?.[0]).toBe(prefix + value);
          expect(encode.mock.calls[1]?.[0]).toBe(suffix);
        } else {
          await readTextChunks(stream({ value }));
          expect(encode).not.toHaveBeenCalled();
        }
      } finally {
        encode.mockRestore();
      }
    },
  );

  it.each(["adapter", "generated"] as const)("bounds the %s ASCII probe at 256 code units", async (entry) => {
    const short = "a".repeat(256);
    const long = "b".repeat(257);
    const result = compileTemplate("<main>{short}<b>{long}</b></main>");
    if (!result.ok) throw new Error(result.error.message);
    const code = generateServerStreamModule(result.value).replace("export const stream", "const stream");
    const stream = new Function(`${code}; return stream;`)() as (
      scope: Record<string, unknown>,
    ) => AsyncIterable<string>;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      if (entry === "adapter") {
        await readByteChunks(renderToReadableStream([short, long]));
        expect(encode.mock.calls).toEqual([[long], [short + long]]);
      } else {
        await readTextChunks(stream({ short, long }));
        expect(encode.mock.calls).toEqual([[long]]);
      }
    } finally {
      encode.mockRestore();
    }
  });

  it.each(["adapter", "generated"] as const)("measures the %s ASCII code-unit boundary", async (entry) => {
    const ascii = "\u0000\u007F";
    const firstNonAscii = "\u0080";
    const lastUnit = "\uFFFF";
    const result = compileTemplate("<main>{ascii}<b>{firstNonAscii}</b><b>{lastUnit}</b></main>");
    if (!result.ok) throw new Error(result.error.message);
    const code = generateServerStreamModule(result.value).replace("export const stream", "const stream");
    const stream = new Function(`${code}; return stream;`)() as (
      scope: Record<string, unknown>,
    ) => AsyncIterable<string>;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      if (entry === "adapter") {
        await readByteChunks(renderToReadableStream([ascii, firstNonAscii, lastUnit]));
        expect(encode.mock.calls).toEqual([[firstNonAscii], [lastUnit], [ascii + firstNonAscii + lastUnit]]);
      } else {
        await readTextChunks(stream({ ascii, firstNonAscii, lastUnit }));
        expect(encode.mock.calls).toEqual([[firstNonAscii], [lastUnit]]);
      }
    } finally {
      encode.mockRestore();
    }
  });

  it.each(["__tachyonAsciiProbeMaxCodeUnits", "__tachyonNonAsciiCodeUnit"])(
    "keeps the generated stream default scope name %s available",
    async (defaultScopeName) => {
      const result = compileTemplate("<main>{value}</main>");
      if (!result.ok) throw new Error(result.error.message);
      const code = generateServerStreamModule(result.value, { defaultScopeName }).replace(
        "export const stream",
        "const stream",
      );
      const stream = new Function(`const ${defaultScopeName} = { value: "default" }; ${code}; return stream;`)() as (
        scope?: Record<string, unknown>,
      ) => AsyncIterable<string>;
      expect(await readTextChunks(stream())).toEqual(["<main>default</main>"]);
    },
  );

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

    expect(chunks.join("").replaceAll("<!---->", "")).toBe(
      `<ul><!--tachyon-for--><li>0:Alice</li><!--/tachyon-for--></ul>`,
    );
  });

  it("delimits a text-only list with its region markers in generated stream output", async () => {
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

    expect(chunks.join("").replaceAll("<!---->", "")).toBe(
      `<main>H<!--tachyon-for--><p>A</p><!--/tachyon-for-->F</main>`,
    );
  });

  it.each([0, 1, 2])(
    "delimits a list inside await with its markers on every server target for %i rows",
    async (count) => {
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
      expect(generated.match(/<!--tachyon-for-->/g)).toHaveLength(1);
      expect(generated.match(/<!--\/tachyon-for-->/g)).toHaveLength(1);
      expect(generated.indexOf("<!--/tachyon-for-->")).toBeLessThan(generated.indexOf("F"));
    },
  );

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
