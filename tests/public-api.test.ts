import { describe, expect, it } from "vitest";
import { catchError } from "../src/index";

describe("public API", () => {
  it("exports catchError from the main entry", () => {
    expect(catchError).toBeTypeOf("function");
  });
});
