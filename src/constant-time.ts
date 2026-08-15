const encoder = new TextEncoder();

const xorEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
};

const digest = async (value: string): Promise<Uint8Array | undefined> => {
  if (!globalThis.crypto?.subtle) {
    return undefined;
  }
  try {
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value)));
  } catch {
    return undefined;
  }
};

export const timingSafeEqual = async (left: unknown, right: unknown): Promise<boolean> => {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  // Fixed-length digests remove the input-length-dependent raw-byte loop. A missing or failed digest is fail-closed.
  return leftDigest && rightDigest ? xorEqual(leftDigest, rightDigest) : false;
};
