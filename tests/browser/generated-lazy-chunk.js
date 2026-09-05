export const bind = (element) => {
  const form = element.querySelector("form");
  if (!form || !element.querySelector("button")) return;
  const submit = (event) => {
    event.preventDefault();
    const submits = Number(form.getAttribute("data-submits") ?? "0") + 1;
    form.setAttribute("data-submits", String(submits));
    element.setAttribute("data-opened", "true");
  };
  const activate = (event) => {
    event.preventDefault();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };
  form.addEventListener("submit", submit);
  element.addEventListener("click", activate);
  return () => {
    form.removeEventListener("submit", submit);
    element.removeEventListener("click", activate);
  };
};
