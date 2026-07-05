import { describe, expect, it } from "vitest";
import { catchError, untrack } from "../src/index";

describe("public API", () => {
  it("exports catchError from the main entry", () => {
    expect(catchError).toBeTypeOf("function");
  });

  it("exports untrack from the main entry", () => {
    expect(untrack).toBeTypeOf("function");
  });
});
