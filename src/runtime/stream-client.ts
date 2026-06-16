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
