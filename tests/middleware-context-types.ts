import {
  createWorkersHandler,
  type WorkersRouteDefinition,
  type WorkersRouteMiddleware,
} from "../src/adapters/workers";
import { requireUser, type RouteMiddleware } from "../src/router";

const guard = requireUser(() => ({ id: "user" }));

const platformMiddleware: RouteMiddleware = (context) => {
  void guard({ ...context, request: context.request.clone() });
  const { request, url, env } = context;
  // @ts-expect-error A guard context must retain the router-issued opaque carrier.
  return guard({ request: request.clone(), url: new URL(url), env });
};

type Bindings = {
  KV: { get: (key: string) => Promise<string> };
};

const workersGuard: WorkersRouteMiddleware<Bindings> = guard;
const workersMiddleware: WorkersRouteMiddleware<Bindings> = (context) => {
  void context.bindings.KV.get("session");
  void workersGuard({ ...context, request: context.request.clone() });
  const { request, url, env, bindings } = context;
  // @ts-expect-error Named public fields cannot reconstruct the opaque Workers middleware context.
  return workersGuard({ request: request.clone(), url: new URL(url), env, bindings });
};

const routes: WorkersRouteDefinition<Bindings>[] = [{ path: "/", render: () => "ok" }];

createWorkersHandler<Bindings>({
  routes,
  middleware: [workersMiddleware],
});

void platformMiddleware;
