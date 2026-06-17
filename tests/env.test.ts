import { describe, expect, it } from "vitest";
import { defineEnvSchema, readEnv } from "../src/env";

describe("environment variables", () => {
  it("reads required, defaulted, public, and constrained environment variables", () => {
    const schema = defineEnvSchema({
      SESSION_SECRET: { required: true },
      NODE_ENV: { default: "development", choices: ["development", "production"] },
      PUBLIC_API_ORIGIN: { public: true, pattern: /^https:\/\// },
    });

    const result = readEnv(
      {
        SESSION_SECRET: "secret",
        PUBLIC_API_ORIGIN: "https://api.example.com",
      },
      schema,
    );

    expect(result.ok && result.value.env).toEqual({
      SESSION_SECRET: "secret",
      NODE_ENV: "development",
      PUBLIC_API_ORIGIN: "https://api.example.com",
    });
    expect(result.ok && result.value.publicEnv).toEqual({ PUBLIC_API_ORIGIN: "https://api.example.com" });
  });

  it("reports missing and invalid environment variables together", () => {
    const result = readEnv(
      { PUBLIC_API_ORIGIN: "http://localhost" },
      defineEnvSchema({
        SESSION_SECRET: { required: true },
        PUBLIC_API_ORIGIN: { public: true, pattern: /^https:\/\// },
      }),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.map((error) => error.name)).toEqual(["SESSION_SECRET", "PUBLIC_API_ORIGIN"]);
  });

  it("requires an explicit public prefix before exposing variables to clients", () => {
    const result = readEnv(
      { API_SECRET: "secret" },
      defineEnvSchema({
        API_SECRET: { public: true },
      }),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error[0]?.message).toContain("must start with PUBLIC_");
  });
});
