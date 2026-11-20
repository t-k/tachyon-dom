import { describe, expect, expectTypeOf, it, vi } from "vitest";
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

describe("large typed search params schemas", () => {
  it.each([
    ["params", "threshold", "threshold", "repeated", "success"],
    ["url", "threshold", "threshold", "reserved", "success"],
    ["string", "threshold", "threshold", "unknown", "error"],
    ["string", "below", "threshold", "repeated", "success"],
    ["string", "threshold", "below", "repeated", "success"],
    ["url", "below", "below", "repeated", "error"],
    ["params", "below", "below", "reserved", "error"],
    ["url", "below", "below", "unknown", "success"],
    ["string", "threshold", "below", "reserved", "error"],
    ["params", "below", "threshold", "unknown", "success"],
  ] as const)(
    "preserves parse semantics for %s with %s fields, %s pairs, %s values and %s",
    (inputType, fields, pairs, shape, outcome) => {
      const fieldCount = fields === "threshold" ? 64 : 63;
      const pairCount = pairs === "threshold" ? 32 : 31;
      const names = ["seen", "capture", "__proto__", "constructor", "", "2", "10"];
      for (let index = names.length; index < fieldCount; index++) names.push(`field-${index}`);
      const queryNames = {
        repeated: ["capture", "seen", "capture", "constructor", "capture"],
        reserved: ["__proto__", "", "constructor", "2", "10", "__proto__"],
        unknown: ["unknown", "capture", "not-a-field", "", "never-in-schema"],
      }[shape];
      const params = new URLSearchParams();
      for (let index = 0; index < pairCount; index++) {
        params.append(queryNames[index % queryNames.length]!, index % 7 === 0 ? "" : `a + ${index} 雪`);
      }
      const input = {
        params,
        string: params.toString(),
        url: new URL(`https://example.test/?${params}`),
      }[inputType];
      const rejected = new RangeError("codec rejected the value");
      const calls: string[] = [];
      const schema = Object.fromEntries(names.map((name) => [name, {
        parse: (values: readonly string[]) => {
          calls.push(name);
          if (outcome === "error" && (name === "capture" || name === "constructor")) throw rejected;
          return values;
        },
        stringify: (values: readonly string[]) => values,
      }]));
      const expected = Object.fromEntries(Object.keys(schema).map((name) => [name, params.getAll(name)]));
      const parse = createSearchParamsSchema(schema).parse;
      const getAll = vi.spyOn(URLSearchParams.prototype, "getAll");
      let result: unknown;
      let failure: unknown;
      let fallbackCalls: number;
      try {
        result = parse(input);
      } catch (error) {
        failure = error;
      } finally {
        fallbackCalls = getAll.mock.calls.length;
        getAll.mockRestore();
      }

      if (outcome === "success") {
        expect(failure).toBeUndefined();
        expect(Object.entries(result as object)).toEqual(Object.entries(expected));
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(Object.hasOwn(result as object, "__proto__")).toBe(true);
        expect(calls).toEqual(Object.keys(schema));
      } else {
        expect(failure).toBeInstanceOf(TypeError);
        expect(failure).toMatchObject({
          message: "Invalid query parameter capture: codec rejected the value",
          cause: rejected,
        });
        expect(calls).toEqual(Object.keys(schema).slice(0, Object.keys(schema).indexOf("capture") + 1));
      }
      expect(fallbackCalls).toBe(fields === "threshold" && pairs === "threshold" ? 1 : calls.length);
    },
  );

  it("propagates the first codec failure before grouping the query", () => {
    const schema = createSearchParamsSchema(Object.fromEntries([
      ["invalid", queryInteger()] as const,
      ...Array.from({ length: 63 }, (_, index) => [`field-${index}`, queryStringList()] as const),
    ]));
    const input = new URLSearchParams({ invalid: "not-a-number" });
    for (let index = 0; index < 31; index++) input.append("unknown", String(index));
    const visit = vi.spyOn(URLSearchParams.prototype, "forEach");
    try {
      expect(() => schema.parse(input)).toThrow("Invalid query parameter invalid: Expected a decimal integer.");
      expect(visit).not.toHaveBeenCalled();
    } finally {
      visit.mockRestore();
    }
  });

  it("keeps unknown names out of the grouped value buckets", () => {
    const schema = createSearchParamsSchema(Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`field-${index}`, queryStringList()] as const),
    ));
    const input = new URLSearchParams();
    for (let index = 0; index < 32; index++) input.append(`outside-query-scope-${index}`, "value");
    const set = Map.prototype.set;
    let unknownWrites = 0;
    const write = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
      if (typeof key === "string" && key.startsWith("outside-query-scope-")) unknownWrites++;
      return set.call(this, key, value);
    });
    try {
      schema.parse(input);
    } finally {
      write.mockRestore();
    }
    expect(unknownWrites).toBe(0);
  });

  it("keeps the outer snapshot stable and lets a reentrant parse observe its own input", () => {
    const original = new URLSearchParams({ trigger: "outer", watched: "before", second: "two" });
    for (let index = 0; index < 30; index++) original.append("outside", String(index));
    let nested: Record<string, readonly string[]> | undefined;
    const values = {
      parse: (entries: readonly string[]) => entries,
      stringify: (entries: readonly string[]) => entries,
    };
    const schema = createSearchParamsSchema(Object.fromEntries([
      ["trigger", {
        ...values,
        parse: (entries: readonly string[]) => {
          if (entries[0] === "outer") {
            original.set("trigger", "inner");
            original.set("watched", "after");
            nested = schema.parse(original);
          }
          return entries;
        },
      }],
      ["watched", values],
      ["second", values],
      ...Array.from({ length: 61 }, (_, index) => [`field-${index}`, values] as const),
    ]));
    const result = schema.parse(original);
    expect(result.watched).toEqual(["before"]);
    expect(nested?.watched).toEqual(["after"]);
    expect(result.second).not.toBe(nested?.second);
    expect(result["field-0"]).not.toBe(result["field-1"]);
  });
});
