import fc, { type AsyncCommand } from "fast-check";
import { describe, expect, it } from "vitest";
import { createResource, createRoot, createSignal, effect, type Resource } from "../src/runtime/signal";
import { propertyParameters } from "./fast-check-config";

// A controllable asynchronous input handed to the real createResource. Each
// fetcher call records a request whose promise is settled explicitly by a
// generated command, so ordering never depends on timers.
type Request = {
  id: number;
  source: string;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  settled: boolean;
  aborted: boolean;
};

type Model = {
  nextId: number;
  latestId: number | undefined;
  loading: boolean;
  data: string | undefined;
  error: string | undefined;
  source: string;
  requestSources: Map<number, string>;
  settled: Set<number>;
  disposed: boolean;
  disposeCount: number;
};

type Real = {
  resource: Resource<string>;
  source: ReturnType<typeof createSignal<string>>;
  requests: Request[];
  observed: Array<string | undefined>;
  ownerDispose: () => void;
  disposeCount: number;
};

/** Lets microtask chains started by the runtime settle (a macrotask boundary). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const createReal = (): Real => {
  const requests: Request[] = [];
  const observed: Array<string | undefined> = [];
  const source = createSignal("s0");
  let resource!: Resource<string>;
  const ownerDispose = createRoot((dispose) => {
    resource = createResource(source, (value, context) => {
      const request: Request = {
        id: requests.length,
        source: value,
        resolve: () => undefined,
        reject: () => undefined,
        settled: false,
        aborted: false,
      };
      context.signal.addEventListener("abort", () => {
        request.aborted = true;
      });
      const promise = new Promise<string>((resolve, reject) => {
        request.resolve = (result) => {
          request.settled = true;
          resolve(result);
        };
        request.reject = (reason) => {
          request.settled = true;
          reject(reason);
        };
      });
      requests.push(request);
      return promise;
    });
    effect(() => {
      observed.push(resource.data());
    });
    return dispose;
  });
  return { resource, source, requests, observed, ownerDispose, disposeCount: 0 };
};

const assertReal = (model: Model, real: Real): void => {
  expect(real.resource.loading()).toBe(model.loading);
  expect(real.resource.data()).toBe(model.data);
  expect(real.resource.error() instanceof Error ? (real.resource.error() as Error).message : undefined).toBe(
    model.error,
  );
  expect(real.requests.length).toBe(model.nextId);
  expect(real.disposeCount).toBe(model.disposeCount);
  // Superseded requests must have been aborted through the fetcher context.
  for (const request of real.requests) {
    if (request.id !== model.latestId && !request.settled) expect(request.aborted).toBe(true);
  }
};

const command = (
  name: string,
  check: (model: Readonly<Model>) => boolean,
  run: (model: Model, real: Real) => Promise<void>,
): AsyncCommand<Model, Real> => ({ check, run, toString: () => name });

const startRequest = (model: Model, source: string): void => {
  model.latestId = model.nextId;
  model.requestSources.set(model.nextId, source);
  model.nextId += 1;
  model.loading = true;
  model.error = undefined;
};

const commands = [
  fc.string({ minLength: 1, maxLength: 3 }).map((suffix) =>
    command(
      `changeSource(${suffix})`,
      (model) => !model.disposed,
      async (model, real) => {
        const next = `s${suffix}`;
        const changed = next !== model.source;
        model.source = next;
        real.source.set(next);
        await settle();
        if (changed) startRequest(model, next);
        assertReal(model, real);
      },
    ),
  ),
  fc.constant(
    command(
      "refetch",
      (model) => !model.disposed,
      async (model, real) => {
        const inFlightSameSource =
          model.loading && model.latestId !== undefined && model.requestSources.get(model.latestId) === model.source;
        void real.resource.refetch().catch(() => undefined);
        await settle();
        if (!inFlightSameSource) startRequest(model, model.source);
        assertReal(model, real);
      },
    ),
  ),
  fc.nat({ max: 30 }).map((pick) =>
    command(
      `resolve(#${pick})`,
      (model) => model.nextId > 0,
      async (model, real) => {
        const pending = real.requests.filter((request) => !request.settled);
        if (pending.length === 0) return;
        const request = pending[pick % pending.length] as Request;
        request.resolve(`${request.source}-ok`);
        model.settled.add(request.id);
        await settle();
        if (!model.disposed && request.id === model.latestId) {
          model.data = `${request.source}-ok`;
          model.error = undefined;
          model.loading = false;
        }
        assertReal(model, real);
      },
    ),
  ),
  fc.nat({ max: 30 }).map((pick) =>
    command(
      `reject(#${pick})`,
      (model) => model.nextId > 0,
      async (model, real) => {
        const pending = real.requests.filter((request) => !request.settled);
        if (pending.length === 0) return;
        const request = pending[pick % pending.length] as Request;
        request.reject(new Error(`${request.source}-failed`));
        model.settled.add(request.id);
        await settle();
        if (!model.disposed && request.id === model.latestId) {
          model.error = `${request.source}-failed`;
          model.loading = false;
        }
        assertReal(model, real);
      },
    ),
  ),
  fc.constant(
    command(
      "dispose",
      (model) => !model.disposed,
      async (model, real) => {
        real.resource.dispose();
        real.ownerDispose();
        real.disposeCount += 1;
        model.disposed = true;
        model.disposeCount += 1;
        model.loading = real.resource.loading();
        await settle();
        assertReal(model, real);
      },
    ),
  ),
  fc.constant(
    command(
      "disposeAgain",
      (model) => model.disposed,
      async (model, real) => {
        const before = real.observed.length;
        real.resource.dispose();
        real.ownerDispose();
        await settle();
        expect(real.observed.length).toBe(before);
        assertReal(model, real);
      },
    ),
  ),
];

describe("asynchronous resource lifecycle state machine", () => {
  it("adopts only the newest settled request and ignores results after dispose", async () => {
    const parameters = propertyParameters({ numRuns: 80 });
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 24 }), async (generated) => {
        let real: Real | undefined;
        try {
          await fc.asyncModelRun(() => {
            real = createReal();
            const model: Model = {
              nextId: 1,
              latestId: 0,
              loading: true,
              data: undefined,
              error: undefined,
              source: "s0",
              requestSources: new Map([[0, "s0"]]),
              settled: new Set(),
              disposed: false,
              disposeCount: 0,
            };
            return { model, real };
          }, generated);
        } finally {
          if (real) {
            const observedBefore = real.observed.length;
            const dataBefore = real.resource.data();
            real.resource.dispose();
            real.ownerDispose();
            // Leave no unsettled input behind and prove late results cannot
            // revive the disposed resource.
            for (const request of real.requests) {
              if (!request.settled) request.resolve(`${request.source}-late`);
            }
            await settle();
            expect(real.resource.data()).toBe(dataBefore);
            expect(real.observed.length).toBe(observedBefore);
            expect(real.requests.every((request) => request.settled)).toBe(true);
          }
        }
      }),
      { ...parameters, verbose: true },
    );
  });

  it("keeps the newest result when an older request settles later and stays unchanged after dispose", async () => {
    const real = createReal();
    await settle();
    real.source.set("s1");
    await settle();
    expect(real.requests).toHaveLength(2);
    (real.requests[1] as Request).resolve("s1-ok");
    await settle();
    expect(real.resource.data()).toBe("s1-ok");
    expect(real.resource.loading()).toBe(false);

    (real.requests[0] as Request).resolve("s0-late");
    await settle();
    expect(real.resource.data()).toBe("s1-ok");
    expect((real.requests[0] as Request).aborted).toBe(true);

    real.source.set("s2");
    await settle();
    expect(real.resource.loading()).toBe(true);
    real.resource.dispose();
    real.ownerDispose();
    (real.requests[2] as Request).resolve("s2-late");
    await settle();
    expect(real.resource.data()).toBe("s1-ok");
    expect(real.observed.at(-1)).toBe("s1-ok");
  });
});
