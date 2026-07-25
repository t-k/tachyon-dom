import { describe, expect, it } from "vitest";
import { createI18n, localeMiddleware } from "../src/i18n";
import { renderRoute } from "../src/router";

describe("i18n routing", () => {
  it("translates with interpolation and falls back to the default locale", () => {
    const i18n = createI18n({
      defaultLocale: "en",
      locales: ["en", "ja"],
      messages: {
        en: { greeting: "Hello {name}", saved: "Saved" },
        ja: { greeting: "こんにちは{name}" },
      },
    });

    expect(i18n.t("ja", "greeting", { name: "Ada" })).toBe("こんにちはAda");
    expect(i18n.t("ja", "saved")).toBe("Saved");
    expect(i18n.localeFromPath("/ja/dashboard")).toBe("ja");
  });

  it("redirects unprefixed requests to the negotiated locale prefix", async () => {
    const middleware = localeMiddleware({
      defaultLocale: "en",
      locales: ["en", "ja"],
      cookieName: "lang",
    });
    const request = new Request("https://example.com/dashboard?tab=1", {
      headers: { "accept-language": "ja,en;q=0.8" },
    });

    const result = await renderRoute([{ path: "/dashboard", render: () => "ok" }], request, {
      middleware: [middleware],
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.status).toBe(302);
    expect(result.ok && result.value.headers.get("location")).toBe("/ja/dashboard?tab=1");
  });
});
