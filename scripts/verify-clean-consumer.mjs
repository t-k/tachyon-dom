import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const optionalPeers = [
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
  await run("pnpm", ["add", tarball, ...peers, "--config.auto-install-peers=false", "--ignore-scripts"], directory);
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
  try {
    await run(
      join(directory, "node_modules", ".bin", "tachyon-dom"),
      ["compile", "component.td", "--target", "client", "--out", "component.js"],
      directory,
    );
    throw new Error("Missing TypeScript did not fail.");
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`;
    if (!output.includes("pnpm add typescript")) throw error;
  }
  const { stdout } = await run("du", ["-sk", join(directory, "node_modules")], directory);
  return Number.parseInt(stdout, 10);
};

const verifyToolingConsumer = async (directory, tarball, manifest) => {
  await writeConsumerManifest(directory);
  const peerSpecs = optionalPeers.map((name) => `${name}@${manifest.devDependencies[name]}`);
  await installTarball(directory, tarball, peerSpecs);
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
if (diagnosticsForTachyonDocument("<main></main>").length !== 0) {
  throw new Error("Language-server diagnostics failed.");
}
`,
  );
  await run(process.execPath, ["verify-tooling.mjs"], directory);
  await writeFile(join(directory, "component.td"), '<script lang="ts">const value: number = 1;</script>\n');
  await run(
    join(directory, "node_modules", ".bin", "tachyon-dom"),
    ["compile", "component.td", "--target", "client", "--out", "component.js"],
    directory,
  );
  await access(join(directory, "component.js"));
};

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packDirectory = await mkdtemp(join(tmpdir(), "tachyon-dom-pack-"));
const runtimeDirectory = await mkdtemp(join(tmpdir(), "tachyon-dom-runtime-consumer-"));
const toolingDirectory = await mkdtemp(join(tmpdir(), "tachyon-dom-tooling-consumer-"));

try {
  await run("pnpm", ["pack", "--pack-destination", packDirectory], root);
  const tarballName = (await readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not produce a tarball.");
  const tarball = join(packDirectory, tarballName);
  const runtimeInstallKiB = await verifyRuntimeOnlyConsumer(runtimeDirectory, tarball);
  await verifyToolingConsumer(toolingDirectory, tarball, manifest);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        pnpm: (await run("pnpm", ["--version"], root)).stdout.trim(),
        runtimeInstallKiB,
        optionalPeersAbsent: optionalPeers,
        toolingConsumer: "passed",
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
