import type { RouteMiddleware } from "./router.js";

export type I18nMessages = Record<string, Record<string, string>>;

export type I18nOptions<Locale extends string = string> = {
  defaultLocale: Locale;
  locales: readonly Locale[];
  messages: Record<Locale, Record<string, string>>;
};

export type LocaleMiddlewareOptions<Locale extends string = string> = {
  defaultLocale: Locale;
  locales: readonly Locale[];
  cookieName?: string;
  status?: number;
};

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

const localeSegment = (pathname: string): string | undefined => trimSlashes(pathname).split("/")[0];

const cookieValue = (header: string | null, name: string): string | undefined => {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
};

const acceptedLanguages = (header: string | null): string[] => {
  if (!header) {
    return [];
  }
  return header
    .split(",")
    .map((entry) => {
      const [tag, ...parameters] = entry.trim().split(";");
      const q = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="))
        ?.slice(2);
      return { tag: tag?.toLowerCase() ?? "", q: q ? Number(q) : 1 };
    })
    .filter((entry) => entry.tag && Number.isFinite(entry.q) && entry.q > 0)
    .sort((left, right) => right.q - left.q)
    .map((entry) => entry.tag);
};

export const createI18n = <Locale extends string>(options: I18nOptions<Locale>) => {
  const localeSet = new Set<string>(options.locales);
  const normalizeLocale = (locale: string | undefined): Locale | undefined => {
    if (!locale) {
      return undefined;
    }
    if (localeSet.has(locale)) {
      return locale as Locale;
    }
    const base = locale.split("-")[0];
    return base && localeSet.has(base) ? (base as Locale) : undefined;
  };
  const localeFromPath = (pathname: string): Locale | undefined => normalizeLocale(localeSegment(pathname));
  const t = (locale: Locale, key: string, values: Record<string, unknown> = {}): string => {
    const message = options.messages[locale]?.[key] ?? options.messages[options.defaultLocale]?.[key] ?? key;
    return message.replace(/\{([A-Za-z_$][\w$]*)\}/g, (_match, name: string) => String(values[name] ?? ""));
  };
  const negotiateLocale = (request: Request): Locale => {
    const pathLocale = localeFromPath(new URL(request.url).pathname);
    if (pathLocale) {
      return pathLocale;
    }
    const cookieLocale = normalizeLocale(cookieValue(request.headers.get("cookie"), "lang"));
    if (cookieLocale) {
      return cookieLocale;
    }
    for (const language of acceptedLanguages(request.headers.get("accept-language"))) {
      const locale = normalizeLocale(language);
      if (locale) {
        return locale;
      }
    }
    return options.defaultLocale;
  };
  return { localeFromPath, negotiateLocale, t };
};

export const localeMiddleware = <Locale extends string>(options: LocaleMiddlewareOptions<Locale>): RouteMiddleware => {
  const i18n = createI18n({
    defaultLocale: options.defaultLocale,
    locales: options.locales,
    messages: Object.fromEntries(options.locales.map((locale) => [locale, {}])) as Record<
      Locale,
      Record<string, string>
    >,
  });
  const localeSet = new Set<string>(options.locales);
  return ({ request, url }) => {
    const firstSegment = localeSegment(url.pathname);
    if (firstSegment && localeSet.has(firstSegment)) {
      return undefined;
    }
    const cookieName = options.cookieName ?? "lang";
    const cookieLocale = cookieValue(request.headers.get("cookie"), cookieName);
    const locale = cookieLocale && localeSet.has(cookieLocale) ? cookieLocale : i18n.negotiateLocale(request);
    const pathname = url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`;
    return new Response(null, {
      status: options.status ?? 302,
      headers: {
        location: `/${locale}${pathname === "/" ? "" : pathname}${url.search}`,
        vary: "accept-language, cookie",
      },
    });
  };
};
