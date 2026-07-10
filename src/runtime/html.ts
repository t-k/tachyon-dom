const clientHtmlBrand = Symbol("tachyon.clientHtml");

export type ClientHtml = {
  readonly [clientHtmlBrand]: true;
  toString(): string;
};

export const rawHtml = (value: string): ClientHtml => ({
  [clientHtmlBrand]: true,
  toString: () => value,
});

export const isClientHtml = (value: unknown): value is ClientHtml =>
  Boolean(value && typeof value === "object" && (value as Record<symbol, unknown>)[clientHtmlBrand] === true);
