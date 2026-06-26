import { err, ok, type Result } from "./result.js";

export type EnvSource = Record<string, string | undefined>;

export type EnvRule = {
  required?: boolean;
  default?: string;
  choices?: readonly string[];
  pattern?: RegExp;
  public?: boolean;
};

export type EnvSchema = Record<string, EnvRule>;

export type EnvReadResult<Schema extends EnvSchema> = {
  env: Partial<{ [Key in keyof Schema]: string }>;
  publicEnv: Partial<{ [Key in keyof Schema]: string }>;
};

export type EnvError = {
  name: string;
  message: string;
};

export type EnvReadOptions = {
  publicPrefix?: string;
};

export const defineEnvSchema = <Schema extends EnvSchema>(schema: Schema): Schema => schema;

export const readEnv = <Schema extends EnvSchema>(
  source: EnvSource,
  schema: Schema,
  options: EnvReadOptions = {},
): Result<EnvReadResult<Schema>, EnvError[]> => {
  const errors: EnvError[] = [];
  const env: Record<string, string> = {};
  const publicEnv: Record<string, string> = {};
  const publicPrefix = options.publicPrefix ?? "PUBLIC_";
  for (const [name, rule] of Object.entries(schema)) {
    if (rule.public && publicPrefix !== "" && !name.startsWith(publicPrefix)) {
      errors.push({ name, message: `${name} must start with ${publicPrefix} to be exposed publicly.` });
      continue;
    }
    const value = source[name] ?? rule.default;
    if (value === undefined || value === "") {
      if (rule.required) {
        errors.push({ name, message: `${name} is required.` });
      }
      continue;
    }
    if (rule.choices && !rule.choices.includes(value)) {
      errors.push({ name, message: `${name} must be one of: ${rule.choices.join(", ")}.` });
      continue;
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      errors.push({ name, message: `${name} does not match the required pattern.` });
      continue;
    }
    env[name] = value;
    if (rule.public) {
      publicEnv[name] = value;
    }
  }
  if (errors.length > 0) {
    return err(errors);
  }
  return ok({ env, publicEnv } as EnvReadResult<Schema>);
};
