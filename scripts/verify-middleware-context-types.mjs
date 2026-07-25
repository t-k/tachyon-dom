import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), "tachyon-middleware-context-package-"));
const consumer = path.join(directory, "consumer");

const source = `
import {
  createWorkersHandler,
  type WorkersRouteDefinition,
  type WorkersRouteMiddleware,
} from "tachyon-dom/adapters/workers";
import { requireUser, type RouteMiddleware } from "tachyon-dom/router";

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
createWorkersHandler<Bindings>({ routes, middleware: [workersMiddleware] });
void platformMiddleware;
`;

try {
  await execFileAsync("pnpm", ["pack", "--pack-destination", directory], { cwd: projectRoot });
  const tarballName = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not create a tarball.");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  await execFileAsync("pnpm", ["add", "--ignore-workspace", path.join(directory, tarballName)], { cwd: consumer });
  const usageFile = path.join(consumer, "usage.ts");
  await writeFile(usageFile, source);
  const installedRoot = await realpath(path.join(consumer, "node_modules/tachyon-dom"));
  if (installedRoot.startsWith(projectRoot)) {
    throw new Error("Type probe resolved the workspace instead of the packed package.");
  }
  const program = ts.createProgram([usageFile], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"),
    );
  }
  console.log(`Installed package middleware context declarations verified from ${installedRoot}.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
