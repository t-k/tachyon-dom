import { describe, expect, expectTypeOf, it } from "vitest";
import { createSearchParamsSchema, queryInteger, queryString, queryStringList } from "../src/router";

describe("typed search params", () => {
  const createSearch = () => createSearchParamsSchema({
    page: queryInteger({ defaultValue: 1, min: 1, max: 100 }),
    term: queryString(""),
    tags: queryStringList(),
    optional: queryString(),
  });

  it("parses defaults and repeated values without admitting unknown keys", () => {
    const search = createSearch();
    const typed: { page: number; term: string; tags: string[]; optional: string | undefined } = search.parse("");
    expect(typed.page).toBe(1);
    expectTypeOf<ReturnType<typeof search.parse>>().toEqualTypeOf<{
      page: number;
      term: string;
      tags: string[];
      optional: string | undefined;
    }>();
    expect(search.parse("?utm_source=mail&tags=one&tags=two&term=a+b")).toEqual({
      page: 1,
      term: "a b",
      tags: ["one", "two"],
      optional: undefined,
    });
  });

  it("serializes known values with URL encoding and omits defaults", () => {
    const search = createSearch();
    const query = search.stringify({ page: 3, term: "a & b", tags: ["first", "second"], optional: undefined });
    expect(query).toBe("page=3&term=a+%26+b&tags=first&tags=second");
    expect(search.parse(query)).toEqual({ page: 3, term: "a & b", tags: ["first", "second"], optional: undefined });
    expect(search.stringify({ page: 1, term: "", tags: [], optional: undefined })).toBe("");
    expect(search.href("/users/42#details", { page: 3, term: "a & b", tags: [], optional: undefined })).toBe(
      "/users/42?page=3&term=a+%26+b#details",
    );
    expect(search.href("/users/42?utm_source=mail&page=99#details", { page: 1, term: "", tags: [], optional: undefined })).toBe(
      "/users/42?utm_source=mail#details",
    );
    expect(search.href("#details", { page: 2, term: "", tags: [], optional: undefined })).toBe("?page=2#details");
    expect(search.href("?utm_source=mail", { page: 2, term: "", tags: [], optional: undefined })).toBe(
      "?utm_source=mail&page=2",
    );
  });

  it("rejects duplicate scalar keys and invalid integer values", () => {
    const search = createSearch();
    expect(search.parse("?page=100").page).toBe(100);
    expect(search.parse("?page=1").page).toBe(1);
    expect(() => search.parse("?page=1&page=2")).toThrow(/page/);
    expect(() => search.parse("?term=a&term=b")).toThrow(/term/);
    expect(() => search.parse("?page=1.5")).toThrow(/page/);
    expect(() => search.parse("?page=0")).toThrow(/page/);
    expect(() => search.parse("?page=101")).toThrow(/page/);
    expect(() => search.parse("?page=9007199254740992")).toThrow(/page/);
    expect(() => search.stringify({ page: 0, term: "", tags: [], optional: undefined })).toThrow(/page/);
    const failure = (() => {
      try {
        search.parse("?page=not-a-number");
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(RangeError);
    let stringifyError: unknown;
    try {
      search.stringify({ page: 0, term: "", tags: [], optional: undefined });
    } catch (error) {
      stringifyError = error;
    }
    expect((stringifyError as Error & { cause?: unknown }).cause).toBeInstanceOf(RangeError);
    expect(() =>
      search.stringify({ page: 1, term: "", tags: [1] as unknown as string[], optional: undefined }),
    ).toThrow(/tags/);
    expect(() =>
      search.stringify({ page: 1, term: 7 as unknown as string, tags: [], optional: undefined }),
    ).toThrow(/term/);
  });

  it("accepts URL and URLSearchParams without mutating the input", () => {
    const search = createSearch();
    const url = new URL("https://example.test/?page=2&tags=x");
    const params = new URLSearchParams(url.search);
    expect(search.parse(url).page).toBe(2);
    expect(search.parse(params).tags).toEqual(["x"]);
    expect(params.toString()).toBe("page=2&tags=x");
    expect(search.href("/users/42", { page: 1, term: "", tags: [], optional: undefined })).toBe("/users/42");
    expect(search.href("/users/42?utm_source=mail", { page: 3, term: "", tags: [], optional: undefined })).toBe(
      "/users/42?utm_source=mail&page=3",
    );
  });

  it("checks integer codec bounds and optional values at construction and use", () => {
    expect(() => queryInteger({ min: 2, max: 1 })).toThrow(/min/);
    expect(() => queryInteger({ min: Number.NaN })).toThrow(/min/);
    expect(() => queryInteger({ max: Number.POSITIVE_INFINITY })).toThrow(/max/);
    expect(() => queryInteger({ defaultValue: 0, min: 1 })).toThrow(/bounds/);
    expect(() => queryInteger({ defaultValue: 101, max: 100 })).toThrow(/bounds/);
    const exact = queryInteger({ min: 2, max: 2 });
    expect(exact.parse(["2"])).toBe(2);
    expect(exact.stringify(2)).toEqual(["2"]);
    const optional = createSearchParamsSchema({ page: queryInteger(), label: queryString() });
    expect(optional.parse("")).toEqual({ page: undefined, label: undefined });
    expect(optional.stringify({ page: undefined, label: undefined })).toBe("");
    expect(optional.parse("?page=-2&label=ok")).toEqual({ page: -2, label: "ok" });
    const invalidCalls = () => {
      // @ts-expect-error An explicitly required default cannot be omitted.
      queryInteger<{ defaultValue: number }>();
      // @ts-expect-error A required string default cannot be omitted.
      queryString<string>();
    };
    expectTypeOf(invalidCalls).toBeFunction();
  });
});
