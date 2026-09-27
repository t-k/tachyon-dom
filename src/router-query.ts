export type QueryField<Value> = {
  parse: (values: readonly string[]) => Value;
  stringify: (value: Value) => readonly string[];
};

type AnyQueryField = {
  parse: (values: readonly string[]) => unknown;
  stringify: (value: never) => readonly string[];
};

type QueryValues<Schema extends Record<string, AnyQueryField>> = {
  -readonly [Key in keyof Schema]: ReturnType<Schema[Key]["parse"]>;
};

export type SearchParamsSchema<Values> = {
  parse: (input: string | URL | URLSearchParams) => Values;
  stringify: (values: Values) => string;
  href: (href: string, values: Values) => string;
};

export const createSearchParamsSchema = <const Schema extends Record<string, AnyQueryField>>(
  schema: Schema,
): SearchParamsSchema<QueryValues<Schema>> => {
  const fields = Object.entries({ ...schema });
  const codec: SearchParamsSchema<QueryValues<Schema>> = {
    parse: (input) => {
      const params = new URLSearchParams(input instanceof URL ? input.search : input);
      const entries = fields.map(([name, field]) => {
        try {
          return [name, field.parse(params.getAll(name))] as const;
        } catch (error) {
          throw new TypeError(`Invalid query parameter ${name}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        }
      });
      return Object.fromEntries(entries) as QueryValues<Schema>;
    },
    stringify: (values) => {
      const params = new URLSearchParams();
      for (const [name, field] of fields) {
        let encoded: readonly string[];
        try {
          encoded = field.stringify(values[name] as never);
        } catch (error) {
          throw new TypeError(`Invalid query parameter ${name}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        }
        for (const value of encoded) params.append(name, value);
      }
      return params.toString();
    },
    href: (href, values) => {
      const hashIndex = href.indexOf("#");
      const beforeHash = hashIndex < 0 ? href : href.slice(0, hashIndex);
      const hash = hashIndex < 0 ? "" : href.slice(hashIndex);
      const queryIndex = beforeHash.indexOf("?");
      const path = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
      const params = new URLSearchParams(queryIndex < 0 ? "" : beforeHash.slice(queryIndex + 1));
      for (const [name] of fields) params.delete(name);
      for (const [name, value] of new URLSearchParams(codec.stringify(values))) params.append(name, value);
      const query = params.toString();
      return `${path}${query ? `?${query}` : ""}${hash}`;
    },
  };
  return codec;
};

const scalar = (values: readonly string[]): string | undefined => {
  if (values.length > 1) throw new RangeError("Expected at most one value.");
  return values[0];
};

export const queryString = <Default extends string | undefined = undefined>(
  ...args: Default extends string ? [defaultValue: Default] : [defaultValue?: Default]
): QueryField<Default extends string ? string : string | undefined> => {
  const defaultValue = args[0];
  return {
    parse: (values: readonly string[]) => scalar(values) ?? defaultValue,
    stringify: (value: string | undefined) => {
      if (value === undefined || value === defaultValue) return [];
      if (typeof value !== "string") throw new TypeError("Expected a string.");
      return [value];
    },
  } as unknown as QueryField<Default extends string ? string : string | undefined>;
};

export type IntegerQueryOptions = { min?: number; max?: number };

export const queryInteger = <Options extends IntegerQueryOptions & { defaultValue?: number } = {}>(
  ...args: Options extends { defaultValue: number } ? [options: Options] : [options?: Options]
): QueryField<Options extends { defaultValue: number } ? number : number | undefined> => {
  const { min, max, defaultValue } = args[0] ?? {};
  if (min !== undefined && !Number.isSafeInteger(min)) throw new RangeError("Query integer min must be a safe integer.");
  if (max !== undefined && !Number.isSafeInteger(max)) throw new RangeError("Query integer max must be a safe integer.");
  if (min !== undefined && max !== undefined && min > max) throw new RangeError("Query integer min exceeds max.");
  const validate = (value: number): number => {
    if (!Number.isSafeInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
      throw new RangeError("Expected an integer within the configured bounds.");
    }
    return value;
  };
  if (defaultValue !== undefined) validate(defaultValue);
  return {
    parse: (values: readonly string[]) => {
      const raw = scalar(values);
      if (raw === undefined) return defaultValue;
      if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) throw new RangeError("Expected a decimal integer.");
      return validate(Number(raw));
    },
    stringify: (value: number | undefined) => {
      if (value === undefined || value === defaultValue) return [];
      return [String(validate(value))];
    },
  } as unknown as QueryField<Options extends { defaultValue: number } ? number : number | undefined>;
};

export const queryStringList = (): QueryField<string[]> => ({
  parse: (values) => [...values],
  stringify: (values) => {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
      throw new TypeError("Expected an array of strings.");
    }
    return [...values];
  },
});
