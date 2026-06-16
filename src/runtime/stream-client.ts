export const readTextStreamChunks = async (stream: ReadableStream<Uint8Array>): Promise<string[]> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      const trailing = decoder.decode();
      if (trailing) {
        chunks.push(trailing);
      }
      return chunks;
    }
    chunks.push(decoder.decode(result.value, { stream: true }));
  }
};

export type DeferredDataChunk = {
  id: string;
  key: string;
  value: unknown;
};

const escapeSelectorValue = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`);

export const applyDeferredDataChunk = (root: ParentNode, chunk: DeferredDataChunk): boolean => {
  const selector = `[data-tachyon-deferred-target="${escapeSelectorValue(`${chunk.id}:${chunk.key}`)}"]`;
  const target = root.querySelector(selector);
  if (!target) {
    return false;
  }
  target.textContent = typeof chunk.value === "string" ? chunk.value : JSON.stringify(chunk.value);
  return true;
};

export const readDeferredDataScript = <T = unknown>(root: ParentNode, id: string): T | undefined => {
  const script = Array.from(root.querySelectorAll(`script[type="application/json"][data-tachyon-deferred]`)).find(
    (candidate) => candidate.getAttribute("data-tachyon-deferred") === id,
  );
  if (!script) {
    return undefined;
  }
  return JSON.parse(script.textContent ?? "null") as T;
};
