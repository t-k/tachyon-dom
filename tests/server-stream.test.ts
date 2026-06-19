import { describe, expect, it } from "vitest";
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
  it("streams iterable chunks without building one HTML string first", async () => {
    const stream = renderToReadableStream(["<h1>", "Hello", "</h1>"]);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    const second = await reader.read();

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("<h1>");
    expect(decoder.decode(second.value)).toBe("Hello");
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
});
