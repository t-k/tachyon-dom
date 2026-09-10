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
    const chunk = decoder.decode(result.value, { stream: true });
    if (chunk) {
      chunks.push(chunk);
    }
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

export type DeferredDataReadError = { kind: "missing"; id: string } | { kind: "invalid"; id: string; cause: unknown };

export const readDeferredDataScriptResult = <T = unknown>(
  root: ParentNode,
  id: string,
): Result<T, DeferredDataReadError> => {
  const script = Array.from(root.querySelectorAll(`script[type="application/json"][data-tachyon-deferred]`)).find(
    (candidate) => candidate.getAttribute("data-tachyon-deferred") === id,
  );
  if (!script) {
    return err({ kind: "missing", id });
  }
  try {
    return ok(JSON.parse(script.textContent ?? "null") as T);
  } catch (cause) {
    return err({ kind: "invalid", id, cause });
  }
};

/** @deprecated Use readDeferredDataScriptResult to distinguish missing and invalid data. */
export const readDeferredDataScript = <T = unknown>(root: ParentNode, id: string): T | undefined => {
  const result = readDeferredDataScriptResult<T>(root, id);
  return result.ok ? result.value : undefined;
};
import { err, ok, type Result } from "../result.js";
