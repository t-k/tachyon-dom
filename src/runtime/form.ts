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

export type EnhanceFormOptions = {
  submit?: (context: EnhancedFormContext) => Response | Promise<Response>;
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

export const enhanceForm = (form: HTMLFormElement, options: EnhanceFormOptions = {}): (() => void) => {
  const submit = options.submit ?? ((context: EnhancedFormContext) => fetch(context.request));
  const listener = (event: SubmitEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    const formData = new FormData(form);
    const request = requestForForm(form, formData);
    const context = { form, request, formData };
    void (async () => {
      try {
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
