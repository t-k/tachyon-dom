import { createHmac, timingSafeEqual } from "node:crypto";

export type CookieOptions = {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export type Session<Data extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  data: Data;
};

export type MemorySessionStorageOptions = {
  cookieName?: string;
  cookie?: CookieOptions;
  id?: () => string;
};

export type CookieSessionStorageOptions = {
  secret: string;
  verificationSecrets?: readonly string[];
  maxAgeMs?: number;
  now?: () => number;
  cookieName?: string;
  cookie?: CookieOptions;
  id?: () => string;
};

const encodeCookiePart = (value: string): string => encodeURIComponent(value).replaceAll("%20", "+");

const decodeCookiePart = (value: string): string => decodeURIComponent(value.replaceAll("+", "%20"));

const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
};

const validateCookiePath = (value: string): string => {
  if (hasControlCharacter(value) || value.includes(";")) {
    throw new Error("Invalid cookie Path.");
  }
  return value;
};

const validateCookieDomain = (value: string): string => {
  if (hasControlCharacter(value) || value.includes(";") || /\s/.test(value) || !/^[A-Za-z0-9.-]+$/.test(value)) {
    throw new Error("Invalid cookie Domain.");
  }
  return value;
};

const tryDecodeCookiePart = (value: string): string | undefined => {
  try {
    return decodeCookiePart(value);
  } catch {
    return undefined;
  }
};

const sessionId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const base64UrlEncode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

const base64UrlDecode = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

const signatureFor = (value: string, secret: string): string =>
  createHmac("sha256", secret).update(value).digest("base64url");

const defaultSessionCookie = (): CookieOptions => ({ httpOnly: true, path: "/", sameSite: "Lax", secure: true });

export const signCookieValue = (value: string, secret: string): string => {
  const payload = base64UrlEncode(value);
  return `${payload}.${signatureFor(payload, secret)}`;
};

export const verifySignedCookieValue = (signedValue: string | undefined, secret: string): string | undefined => {
  if (!signedValue) {
    return undefined;
  }
  const [payload, signature] = signedValue.split(".");
  if (!payload || !signature) {
    return undefined;
  }
  const expected = signatureFor(payload, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return undefined;
  }
  try {
    return base64UrlDecode(payload);
  } catch {
    return undefined;
  }
};

export const parseCookies = (header: string | null | undefined): Record<string, string> => {
  if (!header) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (hasControlCharacter(trimmed)) {
      continue;
    }
    const [rawName, ...rawValue] = trimmed.split("=");
    if (!rawName) {
      continue;
    }
    const name = tryDecodeCookiePart(rawName);
    const value = tryDecodeCookiePart(rawValue.join("="));
    if (name === undefined || value === undefined || hasControlCharacter(name) || hasControlCharacter(value)) {
      continue;
    }
    cookies[name] = value;
  }
  return cookies;
};

export const serializeCookie = (name: string, value: string, options: CookieOptions = {}): string => {
  const parts = [`${encodeCookiePart(name)}=${encodeCookiePart(value)}`];
  if (options.path) {
    parts.push(`Path=${validateCookiePath(options.path)}`);
  }
  if (options.domain) {
    parts.push(`Domain=${validateCookieDomain(options.domain)}`);
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
};

export const createMemorySessionStorage = <Data extends Record<string, unknown> = Record<string, unknown>>(
  options: MemorySessionStorageOptions = {},
) => {
  const cookieName = options.cookieName ?? "tachyon_session";
  const cookieOptions = options.cookie ?? defaultSessionCookie();
  const sessions = new Map<string, Data>();
  const createId = options.id ?? sessionId;

  return {
    createSession: async (data: Data): Promise<Session<Data>> => {
      const id = createId();
      sessions.set(id, data);
      return { id, data };
    },
    getSession: async (cookieHeader: string | null | undefined): Promise<Session<Data>> => {
      const id = parseCookies(cookieHeader)[cookieName];
      if (!id) {
        return { id: "", data: {} as Data };
      }
      const data = sessions.get(id);
      if (data) {
        return { id, data };
      }
      return { id, data: {} as Data };
    },
    commitSession: async (session: Session<Data>): Promise<string> => {
      if (!sessions.has(session.id)) {
        session.id = createId();
      }
      sessions.set(session.id, session.data);
      return serializeCookie(cookieName, session.id, cookieOptions);
    },
    regenerateSession: async (session: Session<Data>): Promise<Session<Data>> => {
      sessions.delete(session.id);
      const regenerated = { id: createId(), data: session.data };
      sessions.set(regenerated.id, regenerated.data);
      return regenerated;
    },
    destroySession: async (session: Session<Data>): Promise<string> => {
      sessions.delete(session.id);
      return serializeCookie(cookieName, "", { ...cookieOptions, maxAge: 0 });
    },
  };
};

export const createCookieSessionStorage = <Data extends Record<string, unknown> = Record<string, unknown>>(
  options: CookieSessionStorageOptions,
) => {
  const cookieName = options.cookieName ?? "__Host-tachyon_session";
  const cookieOptions = options.cookie ?? defaultSessionCookie();
  const maxAgeMs = options.maxAgeMs;
  if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0)) {
    throw new Error("Cookie session maxAgeMs must be a positive finite number.");
  }
  const now = options.now ?? Date.now;
  const createId = options.id ?? sessionId;
  const secrets = [options.secret, ...(options.verificationSecrets ?? [])];

  return {
    createSession: async (data: Data): Promise<Session<Data>> => ({ id: createId(), data }),
    getSession: async (cookieHeader: string | null | undefined): Promise<Session<Data>> => {
      const signed = parseCookies(cookieHeader)[cookieName];
      const verified = secrets.map((secret) => verifySignedCookieValue(signed, secret)).find((value) => value !== undefined);
      if (!verified) {
        return { id: "", data: {} as Data };
      }
      try {
        const parsed = JSON.parse(verified) as Session<Data> & { expiresAt?: unknown };
        if (
          maxAgeMs !== undefined &&
          (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt) || now() >= parsed.expiresAt)
        ) {
          return { id: "", data: {} as Data };
        }
        return { id: parsed.id, data: parsed.data };
      } catch {
        return { id: "", data: {} as Data };
      }
    },
    commitSession: async (session: Session<Data>): Promise<string> => {
      const expiresAt = maxAgeMs === undefined ? undefined : now() + maxAgeMs;
      const payload = expiresAt === undefined ? session : { ...session, expiresAt };
      return serializeCookie(
        cookieName,
        signCookieValue(JSON.stringify(payload), options.secret),
        maxAgeMs === undefined ? cookieOptions : { ...cookieOptions, maxAge: Math.ceil(maxAgeMs / 1_000) },
      );
    },
    destroySession: async (_session: Session<Data>): Promise<string> =>
      serializeCookie(cookieName, "", { ...cookieOptions, maxAge: 0 }),
  };
};
