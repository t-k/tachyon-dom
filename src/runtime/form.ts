import { isSignal, type Accessor } from "./signal.js";

export type BoundControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export const setControlValue = (element: BoundControl, property: "value" | "checked", value: unknown): void => {
  if (property === "checked" && element instanceof HTMLInputElement) {
    element.checked = Boolean(value);
    return;
  }
  element.value = value == null ? "" : String(value);
};

export const writeModelValue = (target: unknown, value: unknown, fallback: () => void): void => {
  if (!isSignal(target)) {
    fallback();
    return;
  }
  const setter = (target as Accessor<unknown> & { set?: (next: unknown) => void }).set;
  if (typeof setter !== "function") {
    throw new TypeError("Cannot write to a readonly signal accessor.");
  }
  setter(value);
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
  let composing = false;
  const commit = (): void => {
    write(property === "checked" && control instanceof HTMLInputElement ? control.checked : control.value);
  };
  const listener = (event: Event): void => {
    if (property === "value" && ((event as InputEvent).isComposing || composing)) {
      return;
    }
    commit();
  };
  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    commit();
  };
  control.addEventListener(eventName, listener);
  if (property === "value") {
    control.addEventListener("compositionstart", onCompositionStart);
    control.addEventListener("compositionend", onCompositionEnd);
  }
  return () => {
    control.removeEventListener(eventName, listener);
    control.removeEventListener("compositionstart", onCompositionStart);
    control.removeEventListener("compositionend", onCompositionEnd);
  };
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

const formMethod = (form: HTMLFormElement): string => (form.getAttribute("method") || "get").toUpperCase();

const formAction = (form: HTMLFormElement): URL => new URL(form.getAttribute("action") || location.href, location.href);

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
    const current = Object.hasOwn(values, name) ? values[name] : undefined;
    if (current === undefined) {
      Object.defineProperty(values, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
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

const matchesPattern = (pattern: RegExp, value: string): boolean => {
  if (!pattern.global && !pattern.sticky) {
    return pattern.test(value);
  }
  const lastIndex = pattern.lastIndex;
  pattern.lastIndex = 0;
  try {
    return pattern.test(value);
  } finally {
    pattern.lastIndex = lastIndex;
  }
};

const setValidationError = (errors: Record<string, string>, name: string, message: string): void => {
  Object.defineProperty(errors, name, {
    configurable: true,
    enumerable: true,
    value: message,
    writable: true,
  });
};

export const validateFormData = (formData: FormData, rules: Record<string, FormFieldRule>): FormValidationResult => {
  const errors: Record<string, string> = {};
  for (const [name, rule] of Object.entries(rules)) {
    const value = fieldStringValue(formData, name);
    const message = rule.message ?? `${name} is invalid.`;
    if (rule.required && value.trim() === "") {
      setValidationError(errors, name, message);
      continue;
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      setValidationError(errors, name, message);
      continue;
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      setValidationError(errors, name, message);
      continue;
    }
    if (rule.pattern && !matchesPattern(rule.pattern, value)) {
      setValidationError(errors, name, message);
      continue;
    }
    const customError = rule.validate?.(value, formData);
    if (customError) {
      setValidationError(errors, name, customError);
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

type SubmitControl = HTMLButtonElement | HTMLInputElement;

const submitControls = (form: HTMLFormElement): SubmitControl[] =>
  Array.from(form.elements).filter((element): element is SubmitControl => {
    if (element instanceof HTMLButtonElement) return element.type === "submit";
    return element instanceof HTMLInputElement && (element.type === "submit" || element.type === "image");
  });

export const enhanceForm = (form: HTMLFormElement, options: EnhanceFormOptions = {}): (() => void) => {
  const submit = options.submit ?? ((context: EnhancedFormContext) => fetch(context.request));
  let phase: "idle" | "validating" | "pending" = "idle";
  let disposed = false;
  let generation = 0;
  let activeDisabledStates: Array<readonly [SubmitControl, boolean]> | undefined;
  const restoreSubmitControls = (): void => {
    for (const [control, disabled] of activeDisabledStates ?? []) control.disabled = disabled;
    activeDisabledStates = undefined;
  };
  const listener = (event: SubmitEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    if (disposed || phase !== "idle") return;
    clearCustomValidity(form);
    if (!form.noValidate && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const formData = event.submitter instanceof HTMLElement ? new FormData(form, event.submitter) : new FormData(form);
    const request = requestForForm(form, formData);
    const context = { form, request, formData };
    phase = "validating";
    const currentGeneration = ++generation;
    const isCurrent = (): boolean => !disposed && generation === currentGeneration;
    void (async () => {
      try {
        const validation = await options.validate?.(context);
        if (!isCurrent()) return;
        if (validation && !validation.ok) {
          applyValidationErrors(form, validation.errors);
          await options.onInvalid?.({ ...context, errors: validation.errors });
          return;
        }
        phase = "pending";
        activeDisabledStates = submitControls(form).map((control) => [control, control.disabled] as const);
        for (const [control] of activeDisabledStates) control.disabled = true;
        const response = await submit(context);
        if (!isCurrent()) return;
        const locationHeader = response.headers.get("location");
        if (response.redirected || (response.status >= 300 && response.status < 400 && locationHeader)) {
          await options.navigate?.(locationHeader ?? response.url, { replace: true });
        }
        if (!isCurrent()) return;
        await options.onSuccess?.({ ...context, response });
      } catch (error) {
        if (isCurrent()) await options.onError?.({ ...context, error });
      } finally {
        if (generation === currentGeneration) {
          restoreSubmitControls();
          phase = "idle";
        }
      }
    })();
  };
  form.addEventListener("submit", listener);
  return () => {
    if (disposed) return;
    disposed = true;
    generation++;
    restoreSubmitControls();
    form.removeEventListener("submit", listener);
  };
};
