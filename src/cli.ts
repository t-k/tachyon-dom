#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { generateClientModule, generateServerModule, generateServerStreamModule } from "./compiler/index";
import { diagnoseTemplate, formatDiagnostic } from "./diagnostics";
import { appendInlineSourceMap, createSourceMap } from "./source-map";
import { err, ok, type Result } from "./result";

export type CliCompileOptions = {
  input: string;
  output?: string;
  target: "client" | "server" | "stream";
  reactive: boolean;
  sourcemap: boolean;
};

const parseArgs = (argv: readonly string[]): Result<CliCompileOptions, string> => {
  const [command, input, ...rest] = argv;
  if (command !== "compile" || !input) {
    return err(
      "Usage: tachyon-dom compile <input> [--target client|server|stream] [--out file] [--reactive] [--no-sourcemap]",
    );
  }
  const options: CliCompileOptions = {
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

export const compileFile = async (options: CliCompileOptions): Promise<Result<string, string>> => {
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

export const runCli = async (argv: readonly string[] = process.argv.slice(2)): Promise<number> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }
  const result = await compileFile(parsed.value);
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  if (!parsed.value.output) {
    console.log(result.value);
  }
  return 0;
};

if (process.argv[1]?.endsWith("cli.js")) {
  process.exitCode = await runCli();
}
