export const normalizeListKey = (value: unknown): PropertyKey => {
  if (typeof value === "string" || typeof value === "symbol") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const rendered = value === null ? "null" : value === undefined ? "undefined" : String(value);
  throw new TypeError(`Invalid keyed list key: ${rendered}. Expected a string, finite number, or symbol.`);
};
