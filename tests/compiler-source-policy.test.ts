import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("compiler source policy", () => {
  it("keeps the direct server renderer eval-free", async () => {
    const source = await readFile("src/compiler/targets/server.ts", "utf8");

    expect(source).not.toContain("new Function");
  });
});
