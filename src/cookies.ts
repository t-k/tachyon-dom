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

const encodeCookiePart = (value: string): string => encodeURIComponent(value).replaceAll("%20", "+");

const decodeCookiePart = (value: string): string => decodeURIComponent(value.replaceAll("+", "%20"));

const sessionId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const parseCookies = (header: string | null | undefined): Record<string, string> => {
  if (!header) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies[decodeCookiePart(rawName)] = decodeCookiePart(rawValue.join("="));
  }
  return cookies;
};

export const serializeCookie = (name: string, value: string, options: CookieOptions = {}): string => {
  const parts = [`${encodeCookiePart(name)}=${encodeCookiePart(value)}`];
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
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
  const cookieOptions = options.cookie ?? { httpOnly: true, path: "/", sameSite: "Lax" as const };
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
      return { id, data: sessions.get(id) ?? ({} as Data) };
    },
    commitSession: async (session: Session<Data>): Promise<string> => {
      sessions.set(session.id, session.data);
      return serializeCookie(cookieName, session.id, cookieOptions);
    },
    destroySession: async (session: Session<Data>): Promise<string> => {
      sessions.delete(session.id);
      return serializeCookie(cookieName, "", { ...cookieOptions, maxAge: 0 });
    },
  };
};
