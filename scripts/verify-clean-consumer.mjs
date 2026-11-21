import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const optionalPeers = [
  "@typescript/typescript6",
  "typescript",
  "oxc-parser",
  "vscode-languageserver",
  "vscode-languageserver-textdocument",
];

const run = async (command, args, cwd) =>
  execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });

const writeConsumerManifest = async (directory) => {
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
};

const assertMissing = async (path) => {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Unexpected optional peer installation: ${path}`);
};

const installTarball = async (directory, tarball, peers = []) => {
  await run("pnpm", ["add", tarball, ...peers, "--config.strict-peer-dependencies=true", "--ignore-scripts"], directory);
};

const verifyRuntimeOnlyConsumer = async (directory, tarball) => {
  await writeConsumerManifest(directory);
  await installTarball(directory, tarball);
  for (const peer of optionalPeers) {
    await assertMissing(join(directory, "node_modules", peer));
  }
  await writeFile(
    join(directory, "verify-runtime.mjs"),
    `
import { createSignal } from "tachyon-dom";
const signal = createSignal(1);
if (signal() !== 1) throw new Error("Root runtime import failed.");

const { compileTemplate } = await import("tachyon-dom/compiler");
const expression = compileTemplate("<p>{user?.profile?.name ?? \`Guest \${fallback}\`}</p>");
if (expression.ok || !expression.error.message.includes("pnpm add oxc-parser")) {
  throw new Error("Missing OXC diagnostic did not include the install command.");
}

const { normalizeHtmlTagWhitespace } = await import("tachyon-dom/app");
if (normalizeHtmlTagWhitespace("<main  id=\\"app\\"></main>") !== '<main id="app"></main>') {
  throw new Error("Cross-runtime whitespace normalization failed.");
}

const { startLanguageServer } = await import("tachyon-dom/language-server");
try {
  startLanguageServer();
  throw new Error("Missing language-server peer did not fail.");
} catch (error) {
  if (!String(error).includes("pnpm add vscode-languageserver")) throw error;
}
`,
  );
  await run(process.execPath, ["verify-runtime.mjs"], directory);
  await writeFile(join(directory, "component.td"), '<script lang="ts">const value: number = 1;</script>\n');
  await verifyTypeScriptTools(directory, "pnpm add @typescript/typescript6");
  const { stdout } = await run("du", ["-sk", join(directory, "node_modules")], directory);
  return Number.parseInt(stdout, 10);
};

const verifyTypeScriptTools = async (directory, missingInstallCommand) => {
  const cli = join(directory, "node_modules", ".bin", "tachyon-dom");
  const commands = [
    ["compile", "component.td", "--target", "client", "--out", "component.js"],
    ["typecheck", "component.td"],
    ["code-preview", "component.td", "--json"],
  ];
  for (const args of commands) {
    if (!missingInstallCommand) {
      const { stdout } = await run(cli, args, directory);
      if (args[0] === "code-preview" && !JSON.parse(stdout).generatedJavaScript) {
        throw new Error("Missing code preview JavaScript.");
      }
      continue;
    }
    try {
      await run(cli, args, directory);
    } catch (error) {
      const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`;
      if (!output.includes(missingInstallCommand)) throw error;
      continue;
    }
    throw new Error(`TypeScript tooling must fail without its API: ${args[0]}`);
  }
  if (!missingInstallCommand) {
    await access(join(directory, "component.js"));
    await writeFile(
      join(directory, "invalid.td"),
      '<script setup lang="ts">const value: number = "wrong";</script>\n<p>{value}</p>\n',
    );
    try {
      await run(cli, ["typecheck", "invalid.td"], directory);
    } catch (error) {
      if (!error.stderr?.includes("Type 'string' is not assignable to type 'number'.")) throw error;
      return;
    }
    throw new Error("Template type checking did not report the invalid assignment.");
  }
};

const verifyToolingConsumer = async (directory, tarball, manifest, typescriptPeers, missingInstallCommand) => {
  await writeConsumerManifest(directory);
  const otherPeers = optionalPeers
    .filter((name) => name !== "typescript" && name !== "@typescript/typescript6")
    .map((name) => `${name}@${manifest.devDependencies[name]}`);
  await installTarball(directory, tarball, [...otherPeers, ...typescriptPeers]);
  await writeFile(
    join(directory, "verify-tooling.mjs"),
    `
import { compileTemplate } from "tachyon-dom/compiler";
import { normalizeHtmlTagWhitespace } from "tachyon-dom/app";
import { diagnosticsForTachyonDocument } from "tachyon-dom/language-server";
const compiled = compileTemplate("<p>{user.name}</p>");
if (!compiled.ok) throw new Error(compiled.error.message);
if (normalizeHtmlTagWhitespace("<main  id=\\"app\\"></main>") !== '<main id="app"></main>') {
  throw new Error("parse5-backed whitespace normalization failed.");
}
if (${!missingInstallCommand} && diagnosticsForTachyonDocument("<main></main>").length !== 0) {
  throw new Error("Language-server diagnostics failed.");
}
`,
  );
  await run(process.execPath, ["verify-tooling.mjs"], directory);
  await writeFile(join(directory, "component.td"), '<script lang="ts">const value: number = 1;</script>\n');
  if (typescriptPeers.includes("typescript@7.0.2")) {
    await writeFile(
      join(directory, "verify-types.ts"),
      'import { createSignal } from "tachyon-dom";\nimport { checkTachyonTemplateTypes } from "tachyon-dom/template-typecheck";\nconst count: number = createSignal(1)();\ncheckTachyonTemplateTypes("<p>" + count + "</p>");\n',
    );
    await run(
      join(directory, "node_modules", ".bin", "tsc"),
      ["--noEmit", "--strict", "--module", "nodenext", "--target", "es2022", "verify-types.ts"],
      directory,
    );
  }
  await verifyTypeScriptTools(directory, missingInstallCommand);
};

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packDirectory = await mkdtemp(join(tmpdir(), "tachyon-dom-pack-"));
const runtimeDirectory = await mkdtemp(join(tmpdir(), "tachyon-dom-runtime-consumer-"));
const toolingDirectory = await mkdtemp(join(tmpdir(), "tachyon-dom-tooling-consumer-"));
const toolingConfigurations = [
  { name: "TypeScript 5.8", peers: ["typescript@5.8.3"] },
  { name: "TypeScript 6", peers: ["typescript@6.0.3"] },
  { name: "TypeScript 7 with the compatibility API", peers: ["typescript@7.0.2", "@typescript/typescript6@6.0.2"] },
  { name: "TypeScript 7 alone", peers: ["typescript@7.0.2"], missing: "pnpm add @typescript/typescript6" },
];

try {
  await run("pnpm", ["pack", "--pack-destination", packDirectory], root);
  const tarballName = (await readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not produce a tarball.");
  const tarball = join(packDirectory, tarballName);
  const runtimeInstallKiB = await verifyRuntimeOnlyConsumer(runtimeDirectory, tarball);
  for (const [index, configuration] of toolingConfigurations.entries()) {
    const directory = join(toolingDirectory, String(index));
    await mkdir(directory);
    await verifyToolingConsumer(directory, tarball, manifest, configuration.peers, configuration.missing);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        pnpm: (await run("pnpm", ["--version"], root)).stdout.trim(),
        runtimeInstallKiB,
        optionalPeersAbsent: optionalPeers,
        toolingConsumers: toolingConfigurations.map(({ name }) => name),
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([
    rm(packDirectory, { recursive: true, force: true }),
    rm(runtimeDirectory, { recursive: true, force: true }),
    rm(toolingDirectory, { recursive: true, force: true }),
  ]);
}
