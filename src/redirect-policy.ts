import { err, ok, type Result } from "./result.js";

export type RedirectPolicyOptions = {
  allowExternal?: boolean;
  allowedOrigins?: readonly string[];
};

const isSafePathRedirect = (location: string): boolean => {
  const controlCharacterPattern = /[\u0000-\u001F\u007F]/;
  if (!location.startsWith("/") || location.startsWith("//") || controlCharacterPattern.test(location)) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(location);
    return !decoded.startsWith("//") && !decoded.includes("\\") && !controlCharacterPattern.test(decoded);
  } catch {
    return false;
  }
};

const isApprovedExternalRedirect = (location: string, allowedOrigins: readonly string[] | undefined): boolean => {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return false;
  }
  try {
    const url = new URL(location);
    return (url.protocol === "https:" || url.protocol === "http:") && allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
};

export const validateRedirectTarget = (
  location: string,
  options: RedirectPolicyOptions = {},
): Result<void, string> =>
  isSafePathRedirect(location) ||
  (options.allowExternal && isApprovedExternalRedirect(location, options.allowedOrigins))
    ? ok(undefined)
    : err(`Unsafe redirect target: ${location}`);
