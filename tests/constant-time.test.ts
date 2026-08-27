import { afterEach, describe, expect, it } from "vitest";
import { timingSafeEqual } from "../src/constant-time";

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

const restoreCrypto = (): void => {
  if (cryptoDescriptor) {
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "crypto");
  }
};

describe.sequential("timingSafeEqual", () => {
  afterEach(restoreCrypto);

  it.each([
    { left: "secret", right: "secret", expected: true },
    { left: "secret", right: "secreu", expected: false },
    { left: "secret", right: "secret-longer", expected: false },
    { left: "", right: "", expected: true },
    { left: "", right: "x", expected: false },
    { left: "秘密", right: "秘密", expected: true },
    { left: "秘密", right: "秘蜜", expected: false },
    { left: undefined, right: "undefined", expected: false },
    { left: null, right: "null", expected: false },
    { left: 1, right: "1", expected: false },
    { left: "value", right: undefined, expected: false },
    { left: "", right: undefined, expected: false },
  ])("returns $expected for $left and $right", async ({ left, right, expected }) => {
    await expect(timingSafeEqual(left, right as string)).resolves.toBe(expected);
  });

  it("fails closed when Web Crypto is unavailable", async () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });

    await expect(timingSafeEqual("secret", "secret")).resolves.toBe(false);
  });

  it("fails closed when Web Crypto digest rejects", async () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        subtle: {
          digest: async () => {
            throw new Error("digest unavailable");
          },
        },
      },
    });

    await expect(timingSafeEqual("secret", "secret")).resolves.toBe(false);
  });

  it.each([1, 2] as const)("fails closed when digest call %i rejects", async (rejectCall) => {
    let digestCalls = 0;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        subtle: {
          digest: async () => {
            digestCalls += 1;
            if (digestCalls === rejectCall) throw new Error("digest unavailable");
            return new Uint8Array([7]).buffer;
          },
        },
      },
    });

    await expect(timingSafeEqual("secret", "secret")).resolves.toBe(false);
  });
});
