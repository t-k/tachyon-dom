#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index";
import { diagnoseTemplate, formatDiagnostic } from "./diagnostics";
import { scanFileRoutes } from "./router";
import { appendInlineSourceMap, createSourceMap } from "./source-map";
import { err, ok, type Result } from "./result";

export type CliCompileOptions = {
  command: "compile";
  input: string;
  output?: string;
  target: "client" | "server" | "stream";
  reactive: boolean;
  sourcemap: boolean;
};

export type CliRoutesOptions = {
  command: "routes";
  routesDir: string;
  output?: string;
};

export type CliServerOptions = {
  command: "dev" | "preview";
  host: string;
  port: number;
};

export type CliOptions = CliCompileOptions | CliRoutesOptions | CliServerOptions;

const parseCompileArgs = (input: string, rest: readonly string[]): Result<CliCompileOptions, string> => {
  if (!input) {
    return err(
      "Usage: tachyon-dom compile <input> [--target client|server|stream] [--out file] [--reactive] [--no-sourcemap]",
    );
  }
  const options: CliCompileOptions = {
    command: "compile",
    input,
    target: "client",
    reactive: false,
    sourcemap: true,
  };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--target") {
      const target = rest[++index];
      if (target !== "client" && target !== "server" && target !== "stream") {
        return err("--target must be client, server, or stream.");
      }
      options.target = target;
    } else if (arg === "--out") {
      const output = rest[++index];
      if (!output) {
        return err("--out requires a file path.");
      }
      options.output = output;
    } else if (arg === "--reactive") {
      options.reactive = true;
    } else if (arg === "--no-sourcemap") {
      options.sourcemap = false;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseRoutesArgs = (routesDir: string, rest: readonly string[]): Result<CliRoutesOptions, string> => {
  if (!routesDir) {
    return err("Usage: tachyon-dom routes <routes-dir> [--out route-manifest.json]");
  }
  const options: CliRoutesOptions = { command: "routes", routesDir };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--out") {
      const output = rest[++index];
      if (!output) {
        return err("--out requires a file path.");
      }
      options.output = output;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseServerArgs = (command: "dev" | "preview", rest: readonly string[]): Result<CliServerOptions, string> => {
  const options: CliServerOptions = { command, host: "127.0.0.1", port: command === "dev" ? 5173 : 4173 };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--host") {
      const host = rest[++index];
      if (!host) {
        return err("--host requires a value.");
      }
      options.host = host;
    } else if (arg === "--port") {
      const port = Number.parseInt(rest[++index] ?? "", 10);
      if (!Number.isFinite(port)) {
        return err("--port requires a number.");
      }
      options.port = port;
    } else {
      return err(`Unknown argument: ${arg}`);
    }
  }
  return ok(options);
};

const parseArgs = (argv: readonly string[]): Result<CliOptions, string> => {
  const [command, input, ...rest] = argv;
  if (command === "compile") {
    return parseCompileArgs(input ?? "", rest);
  }
  if (command === "routes") {
    return parseRoutesArgs(input ?? "", rest);
  }
  if (command === "dev" || command === "preview") {
    return parseServerArgs(
      command,
      [input, ...rest].filter((arg): arg is string => Boolean(arg)),
    );
  }
  return err(
    "Usage: tachyon-dom <compile|routes|dev|preview>. Use compile for templates, routes for file-route manifests, and dev/preview with Vite.",
  );
};

export const compileFile = async (options: Omit<CliCompileOptions, "command">): Promise<Result<string, string>> => {
  const source = await readFile(options.input, "utf8");
  const result = diagnoseTemplate(source);
  if (!result.ok) {
    return err(formatDiagnostic(result.error, options.input));
  }
  const code =
    options.target === "server"
      ? generateServerModule(result.value)
      : options.target === "stream"
        ? generateServerStreamModule(result.value)
        : generateClientModule(result.value, { reactive: options.reactive });
  const output = options.sourcemap
    ? appendInlineSourceMap(code, createSourceMap(source, options.input, options.output))
    : code;
  if (options.output) {
    await writeFile(options.output, output);
  }
  return ok(output);
};

export const buildRouteManifestFile = async (
  options: Omit<CliRoutesOptions, "command">,
): Promise<Result<string, string>> => {
  const manifest = await scanFileRoutes(options.routesDir);
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, output);
  }
  return ok(output);
};

const serverCommandMessage = (options: CliServerOptions): string =>
  options.command === "dev"
    ? `Start Vite dev server with tachyon-dom plugin on ${options.host}:${options.port}.`
    : `Preview the built tachyon-dom app on ${options.host}:${options.port}.`;

export const runCli = async (argv: readonly string[] = process.argv.slice(2)): Promise<number> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  let result: Result<string, string>;
  switch (parsed.value.command) {
    case "dev":
    case "preview":
      console.log(serverCommandMessage(parsed.value));
      return 0;
    case "compile":
      result = await compileFile(parsed.value);
      break;
    case "routes":
      result = await buildRouteManifestFile({
        routesDir: parsed.value.routesDir,
        ...(parsed.value.output ? { output: parsed.value.output } : {}),
      });
      break;
  }
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  if (!("output" in parsed.value) || !parsed.value.output) {
    console.log(result.value);
  }
  return 0;
};

if (process.argv[1]?.endsWith("cli.js")) {
  process.exitCode = await runCli();
}
