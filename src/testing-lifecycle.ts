import { getRuntimeDiagnosticsSnapshot, type RuntimeDiagnosticsSnapshot } from "./runtime/diagnostics.js";
import { hydrate, mount, type ClientTemplateModule, type MountHandle } from "./runtime/mount.js";
import { createRoot } from "./runtime/signal.js";

export type LifecycleMode = "mount" | "hydrate";

export type TemplateLifecycleCase<Scope extends Record<string, unknown>, Observation> = {
  client: ClientTemplateModule<Scope>;
  createScope: (mode: LifecycleMode | "server") => Scope;
  renderServer: (scope: Scope) => string;
  exercise: (root: Element, scope: Scope, mode: LifecycleMode) => void | Promise<void>;
  observe: (root: Element, scope: Scope, mode: LifecycleMode) => Observation;
  afterDispose?: (root: Element, mode: LifecycleMode) => void | Promise<void>;
};

export type TemplateLifecycleResult<Observation> = { mount: Observation; hydrate: Observation };

const sameSnapshot = (left: RuntimeDiagnosticsSnapshot, right: RuntimeDiagnosticsSnapshot): boolean =>
  left.owners === right.owners &&
  left.effects === right.effects &&
  left.subscriptions === right.subscriptions &&
  left.cleanups === right.cleanups;

/** Exercises equivalent client and SSR-hydrated views and checks their observations and owned cleanup. */
export const compareTemplateLifecycles = async <Scope extends Record<string, unknown>, Observation>(
  testCase: TemplateLifecycleCase<Scope, Observation>,
): Promise<TemplateLifecycleResult<Observation>> => {
  const serverBaseline = getRuntimeDiagnosticsSnapshot();
  let disposeServer = (): void => undefined;
  const serverHtml = createRoot((dispose) => {
    disposeServer = dispose;
    const scope = testCase.createScope("server");
    return testCase.renderServer(scope);
  });
  disposeServer();
  if (!sameSnapshot(getRuntimeDiagnosticsSnapshot(), serverBaseline)) {
    throw new Error("server leaked reactive owners, effects, subscriptions, or cleanups.");
  }

  const run = async (mode: LifecycleMode): Promise<Observation> => {
    const baseline = getRuntimeDiagnosticsSnapshot();
    const root = document.createElement("div");
    document.body.append(root);
    let disposeScope = (): void => undefined;
    let handle: MountHandle | undefined;
    let observation!: Observation;
    const failures: unknown[] = [];
    try {
      const scope = createRoot((dispose) => {
        disposeScope = dispose;
        return testCase.createScope(mode);
      });
      if (mode === "mount") {
        handle = mount(root, testCase.client, scope);
      } else {
        root.innerHTML = serverHtml;
        const result = hydrate(root, testCase.client, scope);
        if (!result.ok) throw new Error(result.error.message);
        handle = result.value;
      }
      await testCase.exercise(root, scope, mode);
      observation = testCase.observe(root, scope, mode);
    } catch (error) {
      failures.push(error);
    }
    try {
      handle?.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      disposeScope();
    } catch (error) {
      failures.push(error);
    }
    try {
      await testCase.afterDispose?.(root, mode);
    } catch (error) {
      failures.push(error);
    }
    root.remove();
    if (!sameSnapshot(getRuntimeDiagnosticsSnapshot(), baseline)) {
      failures.push(new Error(`${mode} leaked reactive owners, effects, subscriptions, or cleanups.`));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${mode} lifecycle and cleanup failed.`);
    return observation;
  };

  let mounted!: Observation;
  let hydrated!: Observation;
  let mountFailed = false;
  let hydrateFailed = false;
  let mountError: unknown;
  let hydrateError: unknown;
  try {
    mounted = await run("mount");
  } catch (error) {
    mountFailed = true;
    mountError = error;
  }
  try {
    hydrated = await run("hydrate");
  } catch (error) {
    hydrateFailed = true;
    hydrateError = error;
  }
  if (mountFailed && hydrateFailed) {
    throw new AggregateError([mountError, hydrateError], "Mount and hydrate lifecycles failed.");
  }
  if (mountFailed) throw mountError;
  if (hydrateFailed) throw hydrateError;
  if (JSON.stringify(mounted) !== JSON.stringify(hydrated)) {
    throw new Error("Lifecycle parity mismatch between mount and hydrate.");
  }
  return { mount: mounted, hydrate: hydrated };
};
