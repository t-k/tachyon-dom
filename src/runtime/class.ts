// Self-contained (no module-level helpers): tests serialise this function
// with toString() and run it inside a real browser page.
export const elementAt = (root: Node, path: readonly number[]): Element => {
  let current: Node = root;
  for (const index of path) {
    // Skip SSR hydration marker comments so template paths stay valid.
    let cursor = 0;
    let next: Node | undefined;
    for (const child of Array.from(current.childNodes)) {
      if (
        child.nodeType === 8 &&
        ((child.nodeValue ?? "").startsWith("tachyon-hydrate:") || child.nodeValue === "/tachyon-if")
      )
        continue;
      if (cursor++ === index) {
        next = child;
        break;
      }
    }
    current = next as Node;
  }
  return current as Element;
};

type ManagedClassState = {
  base: string;
  directives: Map<string, boolean>;
};

const managedClasses = new WeakMap<Element, ManagedClassState>();

const classStateFor = (element: Element): ManagedClassState => {
  const existing = managedClasses.get(element);
  if (existing) return existing;
  const state = { base: element.getAttribute("class") ?? "", directives: new Map<string, boolean>() };
  managedClasses.set(element, state);
  return state;
};

const applyClassState = (element: Element, state: ManagedClassState): void => {
  const tokens = new Set(state.base.trim().split(/\s+/).filter(Boolean));
  for (const [className, enabled] of state.directives) {
    if (enabled) tokens.add(className);
  }
  const value = Array.from(tokens).join(" ");
  if (value) element.setAttribute("class", value);
  else element.removeAttribute("class");
};

export const setClassValue = (element: Element, value: unknown): void => {
  const state = classStateFor(element);
  state.base = value == null || value === false || value === true ? "" : String(value);
  applyClassState(element, state);
};

export const setClassPresence = (element: Element, className: string, value: unknown): void => {
  const state = classStateFor(element);
  state.directives.set(className, Boolean(value));
  applyClassState(element, state);
};
