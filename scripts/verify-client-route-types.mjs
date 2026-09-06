import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), "tachyon-client-route-types-package-"));
const consumer = path.join(directory, "consumer");

const positiveSource = `
import { defineClientRoute } from "tachyon-dom";
import type { ClientRouteDefinition } from "tachyon-dom";

const userRoute = defineClientRoute({
  path: "/users/:id",
  load: async ({ params }) => ({ id: params.id, name: \`User \${params.id}\` }),
  target: ({ params, data }) => {
    const id: string = params.id;
    const name: string = data.name;
    void id;
    void name;
    return null;
  },
  head: ({ params, data }) => ({ title: \`\${data.name} (\${params.id})\` }),
  render: ({ params, data }) => \`\${params.id}:\${data.name}\`,
});

const staticRoute = defineClientRoute({
  path: "/settings",
  render: ({ params, data }) => {
    const emptyParams: Record<string, string> = params;
    const unknownData: unknown = data;
    void emptyParams;
    void unknownData;
    return "settings";
  },
});

const dynamicPath: string = Math.random() > 0.5 ? "/users/:id" : "/users/:name";
const dynamicRoute = defineClientRoute({
  path: dynamicPath,
  render: ({ params, data }) => {
    const dynamicParam: string = params.anyName;
    const unknownData: unknown = data;
    void dynamicParam;
    void unknownData;
    return "dynamic";
  },
});

const typedRoute: ClientRouteDefinition<{ id: string; name: string }, { id: string }> = userRoute;
void typedRoute;
void staticRoute;
void dynamicRoute;
`;

const negativeSource = `
import { defineClientRoute } from "tachyon-dom";

defineClientRoute({
  path: "/users/:id",
  load: ({ params }) => {
    const invalidAssignment: number = params.id;
    void invalidAssignment;
    return { name: params.id };
  },
  render: ({ params, data }) => {
    const unknownParam: string = params.missing;
    const unknownData: string = data.missing;
    return \`\${unknownParam}:\${unknownData}\`;
  },
});
`;

const compilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

const diagnosticsFor = (usageFile) => {
  const program = ts.createProgram([usageFile], compilerOptions);
  return ts.getPreEmitDiagnostics(program);
};

const diagnosticText = (diagnostics) =>
  diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n");

const assertPositiveFixture = (usageFile) => {
  const diagnostics = diagnosticsFor(usageFile);
  if (diagnostics.length > 0) {
    throw new Error(`The positive client route type fixture failed:\n${diagnosticText(diagnostics)}`);
  }
};

const assertNegativeFixture = (usageFile) => {
  const diagnostics = diagnosticsFor(usageFile);
  const messages = diagnosticText(diagnostics);
  const missingPropertyErrors = diagnostics.filter((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").includes("Property 'missing' does not exist on type"),
  );
  const missingMessages = [
    ...(messages.includes("Type 'string' is not assignable to type 'number'")
      ? []
      : ["Type 'string' is not assignable to type 'number'"]),
    ...(missingPropertyErrors.length >= 2 ? [] : ["two unknown-property diagnostics"]),
  ];
  if (missingMessages.length > 0) {
    throw new Error(
      `The negative client route type fixture did not reject the expected code.\nExpected diagnostics:\n${missingMessages.join("\n")}\nActual diagnostics:\n${messages}`,
    );
  }
};

try {
  await execFileAsync("pnpm", ["pack", "--pack-destination", directory], { cwd: projectRoot });
  const tarballName = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not create a tarball.");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await execFileAsync("pnpm", ["add", "--ignore-workspace", path.join(directory, tarballName)], { cwd: consumer });
  const installedRoot = await realpath(path.join(consumer, "node_modules/tachyon-dom"));
  if (installedRoot.startsWith(projectRoot)) {
    throw new Error("Type probe resolved the workspace instead of the packed package.");
  }
  const positiveFile = path.join(consumer, "positive.ts");
  const negativeFile = path.join(consumer, "negative.ts");
  await writeFile(positiveFile, positiveSource);
  await writeFile(negativeFile, negativeSource);
  assertPositiveFixture(positiveFile);
  assertNegativeFixture(negativeFile);
  console.log(`Installed package client route declarations verified from ${installedRoot}.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
