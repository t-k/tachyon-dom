import { attr, html, type HtmlFragment } from "./html.js";

export type FormValue = string | string[];

export type FormState<Fields extends string = string> = {
  values: Partial<Record<Fields, FormValue>>;
  fieldErrors: Partial<Record<Fields, string>>;
  formError?: string;
  notice?: string;
};

export type FormActionResult<Input, ErrorState> = { ok: true; value: Input } | { ok: false; error: ErrorState };

export type FormActionContext = {
  request: Request;
  formData: FormData;
};

export type FormActionOptions<Input, ErrorState> = {
  parse: (
    formData: FormData,
    context: FormActionContext,
  ) => FormActionResult<Input, ErrorState> | Promise<FormActionResult<Input, ErrorState>>;
  onSuccess: (context: FormActionContext & { input: Input }) => Response | Promise<Response>;
  onError: (context: FormActionContext & { error: ErrorState }) => Response | Promise<Response>;
};

export type PreserveFormValuesOptions = {
  sensitiveNames?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
};

export type RedirectResponseOptions = ResponseInit & {
  allowExternal?: boolean;
  allowedOrigins?: readonly string[];
};

export type FormFieldOptions = {
  id?: string;
  name?: string;
  errorId?: string;
};

const defaultSensitiveNames = ["password", "currentPassword", "newPassword", "confirmPassword", "passwordConfirmation"];

const stringValue = (value: FormDataEntryValue): string =>
  typeof File !== "undefined" && value instanceof File ? value.name : String(value);

const fieldIdFor = (name: string): string =>
  name.replaceAll(/[^A-Za-z0-9_-]+/g, "-").replaceAll(/^-|-$/g, "") || "field";

const appendValue = (values: Record<string, FormValue>, name: string, value: string): void => {
  const current = values[name];
  if (current === undefined) {
    values[name] = value;
  } else if (Array.isArray(current)) {
    current.push(value);
  } else {
    values[name] = [current, value];
  }
};

export const formState = <Fields extends string = string>(
  state: Partial<FormState<Fields>> = {},
): FormState<Fields> => ({
  values: state.values ?? {},
  fieldErrors: state.fieldErrors ?? {},
  ...(state.formError !== undefined ? { formError: state.formError } : {}),
  ...(state.notice !== undefined ? { notice: state.notice } : {}),
});

export const preserveFormValues = (
  formData: FormData,
  options: PreserveFormValuesOptions = {},
): Record<string, FormValue> => {
  const sensitiveNames = new Set(options.sensitiveNames ?? defaultSensitiveNames);
  const include = options.include ? new Set(options.include) : undefined;
  const exclude = new Set(options.exclude ?? []);
  const values: Record<string, FormValue> = {};
  for (const [name, value] of formData) {
    if (sensitiveNames.has(name) || exclude.has(name) || (include && !include.has(name))) {
      continue;
    }
    appendValue(values, name, stringValue(value));
  }
  return values;
};

const isSafePathRedirect = (location: string): boolean => {
  if (!location.startsWith("/") || location.startsWith("//")) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(location);
    return !decoded.startsWith("//") && !decoded.includes("\\");
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

export const redirectResponse = (location: string, init: RedirectResponseOptions = {}): Response => {
  if (
    !isSafePathRedirect(location) &&
    !(init.allowExternal && isApprovedExternalRedirect(location, init.allowedOrigins))
  ) {
    throw new Error(`Unsafe redirect target: ${location}`);
  }
  const headers = new Headers(init.headers);
  headers.set("location", location);
  return new Response(null, { ...init, status: init.status ?? 303, headers });
};

export const formAction = <Input, ErrorState>({
  parse,
  onSuccess,
  onError,
}: FormActionOptions<Input, ErrorState>): ((request: Request) => Promise<Response>) => {
  return async (request) => {
    const formData = await request.formData();
    const context = { request, formData };
    const result = await parse(formData, context);
    if (result.ok) {
      return onSuccess({ ...context, input: result.value });
    }
    return onError({ ...context, error: result.error });
  };
};

export const formField = <Fields extends string>(
  state: FormState<Fields>,
  fieldName: Fields,
  options: FormFieldOptions = {},
): {
  inputAttrs: () => ReturnType<typeof attr>[];
  error: () => HtmlFragment;
  errorId: string;
  value: FormValue | undefined;
} => {
  const name = options.name ?? fieldName;
  const id = options.id ?? fieldIdFor(name);
  const error = state.fieldErrors[fieldName];
  const errorId = options.errorId ?? `${id}-error`;
  const value = state.values[fieldName];
  return {
    errorId,
    value,
    inputAttrs: () => {
      const firstValue = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
      return [
        attr("name", name),
        attr("id", id),
        attr("value", firstValue),
        attr("aria-invalid", error ? "true" : undefined),
        attr("aria-describedby", error ? errorId : undefined),
      ];
    },
    error: () => (error ? html`<p${attr("id", errorId)} role="alert">${error}</p>` : html``),
  };
};
