export type EnhancementCleanup = () => void;
export type EnhancementInitializer = (root: Element) => void | EnhancementCleanup;

export type EnhancementRegistry = {
  register: (name: string, initializer: EnhancementInitializer) => () => void;
  enhance: (root?: ParentNode) => number;
  cleanup: (root?: ParentNode) => number;
};

const enhancementAttribute = "data-td-enhance";

const rootsFor = (root: ParentNode): Element[] => {
  const elements: Element[] = [];
  if (root instanceof Element && root.hasAttribute(enhancementAttribute)) {
    elements.push(root);
  }
  elements.push(...Array.from(root.querySelectorAll(`[${enhancementAttribute}]`)));
  return elements;
};

const enhancementNamesFor = (element: Element): string[] =>
  (element.getAttribute(enhancementAttribute) ?? "")
    .split(/\s+/)
    .map((name) => name.trim())
    .filter(Boolean);

export const createEnhancementRegistry = (): EnhancementRegistry => {
  const initializers = new Map<string, EnhancementInitializer>();
  const initialized = new WeakMap<Element, Map<string, EnhancementCleanup | undefined>>();
  return {
    register: (name, initializer) => {
      if (initializers.has(name)) {
        throw new Error(`Enhancement is already registered: ${name}`);
      }
      initializers.set(name, initializer);
      return () => {
        initializers.delete(name);
      };
    },
    enhance: (root = document) => {
      let count = 0;
      for (const element of rootsFor(root)) {
        const active = initialized.get(element) ?? new Map<string, EnhancementCleanup | undefined>();
        for (const name of enhancementNamesFor(element)) {
          if (active.has(name)) {
            continue;
          }
          const initializer = initializers.get(name);
          if (!initializer) {
            continue;
          }
          const cleanup = initializer(element);
          active.set(name, cleanup || undefined);
          count += 1;
        }
        if (active.size > 0) {
          initialized.set(element, active);
        }
      }
      return count;
    },
    cleanup: (root = document) => {
      let count = 0;
      for (const element of rootsFor(root)) {
        const active = initialized.get(element);
        if (!active) {
          continue;
        }
        for (const cleanup of active.values()) {
          cleanup?.();
          count += 1;
        }
        active.clear();
        initialized.delete(element);
      }
      return count;
    },
  };
};

const defaultRegistry = createEnhancementRegistry();

export const registerEnhancement = defaultRegistry.register;
export const enhance = defaultRegistry.enhance;
export const cleanupEnhancements = defaultRegistry.cleanup;
