export type HtmlChunk = string | Uint8Array;
export type HtmlChunkSource = Iterable<HtmlChunk | Promise<HtmlChunk>> | AsyncIterable<HtmlChunk>;

const encoder = new TextEncoder();

const isAsyncIterable = (value: HtmlChunkSource): value is AsyncIterable<HtmlChunk> => Symbol.asyncIterator in value;

const toBytes = (chunk: HtmlChunk): Uint8Array => (typeof chunk === "string" ? encoder.encode(chunk) : chunk);

async function* toAsyncChunks(source: HtmlChunkSource): AsyncIterable<HtmlChunk> {
  if (isAsyncIterable(source)) {
    yield* source;
    return;
  }
  for (const chunk of source) {
    yield await chunk;
  }
}

export const renderToReadableStream = (chunks: HtmlChunkSource): ReadableStream<Uint8Array> => {
  const iterator = toAsyncChunks(chunks)[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) {
        return;
      }
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        const bytes = toBytes(result.value);
        if (bytes.byteLength > 0) {
          controller.enqueue(bytes);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      cancelled = true;
      await iterator.return?.();
    },
  });
};

export const renderToResponse = (chunks: HtmlChunkSource, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  return new Response(renderToReadableStream(chunks), { ...init, headers });
};
