// @vitest-environment node
// Production builds reuse an effect's run owner when the previous run registered no cleanup. That path is
// compiled out of development builds, so these regressions run against real esbuild output with the production
// define set, instrumented only to count owner allocations.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

type SignalModule = {
  createSignal: <T>(initial: T) => { (): T; set: (value: T) => void };
  effect: (fn: () => unknown) => () => void;
  createRoot: <T>(fn: (dispose: () => void) => T) => T;
  createReactiveErrorScope: (handle: (error: unknown) => void) => {
    run: <T>(fn: () => T) => T;
    dispose: () => void;
  };
  onCleanup: (fn: () => void) => boolean;
  __ownerAllocations: () => number;
};

const instrumentedModule = async (production: boolean): Promise<SignalModule> => {
  const source = await readFile("src/runtime/signal.ts", "utf8");
  const marker = "const createOwner = (): Owner => {";
  expect(source.split(marker)).toHaveLength(2);
  const contents = `let __allocations = 0;
export const __ownerAllocations = () => __allocations;
${source.replace(marker, `${marker}\n  __allocations += 1;`)}`;
  const result = await build({
    stdin: { contents, loader: "ts", resolveDir: process.cwd(), sourcefile: "signal.ts" },
    bundle: true,
    format: "esm",
    logLevel: "silent",
    platform: "browser",
    write: false,
    define: { __TACHYON_PRODUCTION__: String(production) },
  });
  const encoded = Buffer.from(result.outputFiles![0]!.contents).toString("base64");
  return (await import(`data:text/javascript;base64,${encoded}`)) as SignalModule;
};

describe("production signal runtime", () => {
  it("reuses an empty run owner and keeps allocating one per run in development", async () => {
    const runs = 200;
    const allocationsFor = async (production: boolean) => {
      const api = await instrumentedModule(production);
      const before = api.__ownerAllocations();
      const seen: number[] = [];
      const dispose = api.createRoot((disposeRoot) => {
        const count = api.createSignal(0);
        api.effect(() => {
          seen.push(count());
        });
        for (let index = 1; index <= runs; index++) count.set(index);
        return disposeRoot;
      });
      dispose();
      expect(seen).toHaveLength(runs + 1);
      return api.__ownerAllocations() - before;
    };

    expect(await allocationsFor(true)).toBeLessThanOrEqual(2);
    expect(await allocationsFor(false)).toBeGreaterThanOrEqual(runs);
  }, 60_000);

  it("stops reusing the owner as soon as a run registers cleanup", async () => {
    const api = await instrumentedModule(true);
    const events: string[] = [];
    const source = api.createSignal(0);

    const dispose = api.createRoot((disposeRoot) => {
      api.effect(() => {
        const value = source();
        if (value % 2 === 1) api.onCleanup(() => events.push(`cleanup:${value}`));
        events.push(`run:${value}`);
      });
      return disposeRoot;
    });
    source.set(1);
    source.set(2);
    source.set(3);
    dispose();

    // Each cleanup runs exactly once, before the next run, and never leaks into a later run's owner.
    expect(events).toEqual(["run:0", "run:1", "cleanup:1", "run:2", "run:3", "cleanup:3"]);
  }, 60_000);

  it("drops a stale asynchronous rejection instead of delivering it to the current run", async () => {
    const api = await instrumentedModule(true);
    const errors: string[] = [];
    const scope = api.createReactiveErrorScope((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    });
    const source = api.createSignal(0);
    let rejectFirst: ((error: Error) => void) | undefined;

    const dispose = scope.run(() =>
      api.effect(() => {
        const value = source();
        if (value === 0) {
          return new Promise((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return undefined;
      }),
    );

    source.set(1);
    rejectFirst?.(new Error("stale run"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual([]);
    dispose();
    scope.dispose();
  }, 60_000);

  it("still delivers a rejection from the run that is current", async () => {
    const api = await instrumentedModule(true);
    const errors: string[] = [];
    const scope = api.createReactiveErrorScope((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    });

    const dispose = scope.run(() =>
      api.effect(async () => {
        throw new Error("current run");
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(["current run"]);
    dispose();
    scope.dispose();
  }, 60_000);
});
