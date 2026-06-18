export type BoundControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export const setControlValue = (element: BoundControl, property: "value" | "checked", value: unknown): void => {
  if (property === "checked" && element instanceof HTMLInputElement) {
    element.checked = Boolean(value);
    return;
  }
  element.value = value == null ? "" : String(value);
};

export const bindControl = (
  element: Element,
  property: "value" | "checked",
  read: () => unknown,
  write: (value: unknown) => void,
): (() => void) => {
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    )
  ) {
    return () => undefined;
  }
  const control = element;
  setControlValue(control, property, read());
  const eventName = property === "checked" ? "change" : "input";
  const listener = (): void => {
    write(property === "checked" && control instanceof HTMLInputElement ? control.checked : control.value);
  };
  control.addEventListener(eventName, listener);
  return () => control.removeEventListener(eventName, listener);
};

export type EnhancedFormContext = {
  form: HTMLFormElement;
  request: Request;
  formData: FormData;
};

export type FormFieldRule = {
  required?: boolean;
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
  message?: string;
  validate?: (value: string, formData: FormData) => string | undefined | null;
};

export type FormValidationResult =
  | { ok: true; values: Record<string, FormDataEntryValue | FormDataEntryValue[]> }
  | { ok: false; errors: Record<string, string> };

export type EnhanceFormOptions = {
  validate?: (context: EnhancedFormContext) => FormValidationResult | Promise<FormValidationResult>;
  submit?: (context: EnhancedFormContext) => Response | Promise<Response>;
  onInvalid?: (context: EnhancedFormContext & { errors: Record<string, string> }) => void | Promise<void>;
  onSuccess?: (context: EnhancedFormContext & { response: Response }) => void | Promise<void>;
  onError?: (context: EnhancedFormContext & { error: unknown }) => void | Promise<void>;
  navigate?: (href: string, options?: { replace?: boolean }) => void | Promise<void>;
};

const formMethod = (form: HTMLFormElement): string => (form.method || "get").toUpperCase();

const formAction = (form: HTMLFormElement): URL => new URL(form.action || location.href, location.href);

const requestForForm = (form: HTMLFormElement, formData: FormData): Request => {
  const method = formMethod(form);
  const url = formAction(form);
  if (method === "GET") {
    for (const [name, value] of formData) {
      url.searchParams.append(name, String(value));
    }
    return new Request(url, { method });
  }
  return new Request(url, { method, body: formData });
};

const valuesForFormData = (formData: FormData): Record<string, FormDataEntryValue | FormDataEntryValue[]> => {
  const values: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
  for (const [name, value] of formData) {
    const current = values[name];
    if (current === undefined) {
      values[name] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      values[name] = [current, value];
    }
  }
  return values;
};

const fieldStringValue = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof File !== "undefined" && value instanceof File ? value.name : String(value ?? "");
};

export const validateFormData = (formData: FormData, rules: Record<string, FormFieldRule>): FormValidationResult => {
  const errors: Record<string, string> = {};
  for (const [name, rule] of Object.entries(rules)) {
    const value = fieldStringValue(formData, name);
    const message = rule.message ?? `${name} is invalid.`;
    if (rule.required && value.trim() === "") {
      errors[name] = message;
      continue;
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      errors[name] = message;
      continue;
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      errors[name] = message;
      continue;
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      errors[name] = message;
      continue;
    }
    const customError = rule.validate?.(value, formData);
    if (customError) {
      errors[name] = customError;
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values: valuesForFormData(formData) };
};

const isSettableControl = (element: Element): element is BoundControl =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;

const clearCustomValidity = (form: HTMLFormElement): void => {
  for (const element of Array.from(form.elements)) {
    if (isSettableControl(element)) {
      element.setCustomValidity("");
      element.removeAttribute("aria-invalid");
    }
  }
};

const namedControl = (form: HTMLFormElement, name: string): BoundControl | undefined =>
  Array.from(form.elements).find(
    (element): element is BoundControl => isSettableControl(element) && element.name === name,
  );

const applyValidationErrors = (form: HTMLFormElement, errors: Record<string, string>): void => {
  let firstInvalid: BoundControl | undefined;
  for (const [name, message] of Object.entries(errors)) {
    const control = namedControl(form, name);
    if (!control) {
      continue;
    }
    control.setCustomValidity(message);
    control.setAttribute("aria-invalid", "true");
    firstInvalid ??= control;
  }
  firstInvalid?.focus();
  form.reportValidity();
};

export const enhanceForm = (form: HTMLFormElement, options: EnhanceFormOptions = {}): (() => void) => {
  const submit = options.submit ?? ((context: EnhancedFormContext) => fetch(context.request));
  const listener = (event: SubmitEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    clearCustomValidity(form);
    if (!form.noValidate && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const formData = new FormData(form);
    const request = requestForForm(form, formData);
    const context = { form, request, formData };
    void (async () => {
      try {
        const validation = await options.validate?.(context);
        if (validation && !validation.ok) {
          applyValidationErrors(form, validation.errors);
          await options.onInvalid?.({ ...context, errors: validation.errors });
          return;
        }
        const response = await submit(context);
        const locationHeader = response.headers.get("location");
        if (response.redirected || (response.status >= 300 && response.status < 400 && locationHeader)) {
          await options.navigate?.(locationHeader ?? response.url, { replace: true });
        }
        await options.onSuccess?.({ ...context, response });
      } catch (error) {
        await options.onError?.({ ...context, error });
      }
    })();
  };
  form.addEventListener("submit", listener);
  return () => form.removeEventListener("submit", listener);
};
