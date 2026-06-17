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
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value)));
};

export const timingSafeEqual = async (left: unknown, right: string): Promise<boolean> => {
  if (typeof left !== "string") {
    return false;
  }
  const leftDigest = await digest(left);
  const rightDigest = await digest(right);
  if (leftDigest && rightDigest) {
    return xorEqual(leftDigest, rightDigest);
  }
  return xorEqual(encoder.encode(left), encoder.encode(right));
};
