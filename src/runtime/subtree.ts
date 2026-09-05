type OwnedCleanup = () => void;

const ownedCleanups = new WeakMap<Node, OwnedCleanup>();

export const runCleanups = (cleanups: Array<() => void>): void => {
  const pending = cleanups.splice(0).reverse();
  let firstError: unknown;
  let failed = false;
  for (const cleanup of pending) {
    try {
      cleanup();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
};

export const registerOwnedSubtree = (owner: Node, cleanup: OwnedCleanup): void => {
  ownedCleanups.set(owner, cleanup);
};

export const cleanupOwnedSubtree = (root: Node): void => {
  let firstError: unknown;
  let failed = false;
  for (const child of Array.from(root.childNodes)) {
    try {
      cleanupOwnedSubtree(child);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  const cleanup = ownedCleanups.get(root);
  if (cleanup) {
    ownedCleanups.delete(root);
    try {
      cleanup();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
};
