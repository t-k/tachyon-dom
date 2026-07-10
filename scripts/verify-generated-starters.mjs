import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const run = async (command, args, cwd) => {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, CI: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${stdout}${stderr}`, { cause: error });
  }
};

const verifyGeneratedProject = async (directory, packageTarball) => {
  await run("pnpm", ["add", `tachyon-dom@file:${packageTarball}`], directory);
  await run("pnpm", ["typecheck"], directory);
  await run("pnpm", ["test"], directory);
  await run("pnpm", ["build"], directory);
  const initialHtml = await readFile(path.join(directory, "dist", "index.html"), "utf8");
  if (!initialHtml.includes("Welcome")) throw new Error(`${directory} did not build the Welcome page.`);

  const appFile = path.join(directory, "src", "app.ts");
  const pageFile = path.join(directory, "src", "routes", "index", "page.td");
  const appBefore = await readFile(appFile, "utf8");
  const pageBefore = await readFile(pageFile, "utf8");
  if (!pageBefore.includes('title: "Welcome"')) throw new Error(`${pageFile} does not contain the starter title.`);
  await writeFile(pageFile, pageBefore.replace('title: "Welcome"', 'title: "Edited"'));
  await run("pnpm", ["typecheck"], directory);
  await run("pnpm", ["build"], directory);
  const appAfter = await readFile(appFile, "utf8");
  const editedHtml = await readFile(path.join(directory, "dist", "index.html"), "utf8");
  if (appAfter !== appBefore) throw new Error(`${appFile} changed while editing the route-local scope.`);
  if (!editedHtml.includes("Edited")) throw new Error(`${directory} did not rebuild the edited route-local scope.`);
};

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "tachyon-dom-starter-verification-"));
try {
  const artifacts = path.join(temporaryRoot, "artifacts");
  const harness = path.join(temporaryRoot, "harness");
  const cliProject = path.join(temporaryRoot, "tachyon-cli-app");
  const createProject = path.join(temporaryRoot, "tachyon-create-app");
  await mkdir(artifacts, { recursive: true });
  await mkdir(harness, { recursive: true });
  await writeFile(path.join(harness, "package.json"), '{"private":true,"type":"module"}\n');

  await run("pnpm", ["build"], projectRoot);
  await run("pnpm", ["exec", "tsc", "-p", "packages/create-tachyon-dom/tsconfig.json"], projectRoot);
  await run("pnpm", ["pack", "--pack-destination", artifacts], projectRoot);
  await run("pnpm", ["pack", "--pack-destination", artifacts], path.join(projectRoot, "packages", "create-tachyon-dom"));

  const tachyonTarball = path.join(artifacts, "tachyon-dom-0.1.0.tgz");
  const createTarball = path.join(artifacts, "create-tachyon-dom-0.1.0.tgz");
  await run(
    "pnpm",
    ["pkg", "set", `pnpm.overrides.create-tachyon-dom>tachyon-dom=file:${tachyonTarball}`],
    harness,
  );
  await run("pnpm", ["add", tachyonTarball, createTarball], harness);
  await run("pnpm", ["exec", "tachyon-dom", "init", "--out", cliProject, "--template", "basic"], harness);
  await run("pnpm", ["exec", "create-tachyon-dom", createProject, "--template", "basic"], harness);

  await verifyGeneratedProject(cliProject, tachyonTarball);
  await verifyGeneratedProject(createProject, tachyonTarball);
  process.stdout.write("Verified tachyon-dom init and create-tachyon-dom generated projects.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
