import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { formatBenchmarkSummary, type SummaryInput } from "./markdown";

type SummarySuite = SummaryInput["suite"];

export type SummaryCliOptions = {
  suite: SummarySuite;
  webPath?: string;
  localPath?: string;
  clientPath?: string;
  outputPath: string;
};

export const parseSummaryArgs = (argv: readonly string[]): SummaryCliOptions => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of input"}.`);
    }
    if (!new Set(["--suite", "--web", "--local", "--client", "--output"]).has(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
    values.set(key, value);
  }
  const suite = values.get("--suite");
  if (suite !== "all" && suite !== "web-framework" && suite !== "js-framework" && suite !== "client-bundle") {
    throw new Error(`Unknown suite: ${suite ?? "missing"}`);
  }
  const webPath = values.get("--web");
  const localPath = values.get("--local");
  const clientPath = values.get("--client");
  const outputPath = values.get("--output");
  if ((suite === "all" || suite === "web-framework") && !webPath) {
    throw new Error("--web is required for the selected suite.");
  }
  if ((suite === "all" || suite === "js-framework") && !localPath) {
    throw new Error("--local is required for the selected suite.");
  }
  if ((suite === "all" || suite === "client-bundle") && !clientPath) {
    throw new Error("--client is required for the selected suite.");
  }
  if (!outputPath) {
    throw new Error("--output is required.");
  }
  return {
    suite,
    ...(webPath ? { webPath } : {}),
    ...(localPath ? { localPath } : {}),
    ...(clientPath ? { clientPath } : {}),
    outputPath,
  };
};

const readJson = async (filePath: string): Promise<unknown> => JSON.parse(await readFile(filePath, "utf8"));

const buildSummaryInput = async (options: SummaryCliOptions): Promise<SummaryInput> => {
  if (options.suite === "web-framework") {
    return { suite: options.suite, webFramework: await readJson(options.webPath as string) };
  }
  if (options.suite === "js-framework") {
    return { suite: options.suite, localCompare: await readJson(options.localPath as string) };
  }
  if (options.suite === "client-bundle") {
    return { suite: options.suite, clientBundle: await readJson(options.clientPath as string) };
  }
  return {
    suite: options.suite,
    webFramework: await readJson(options.webPath as string),
    localCompare: await readJson(options.localPath as string),
    clientBundle: await readJson(options.clientPath as string),
  };
};

export const runSummaryCli = async (argv: readonly string[]): Promise<void> => {
  const options = parseSummaryArgs(argv);
  const markdown = formatBenchmarkSummary(await buildSummaryInput(options));
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, markdown);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runSummaryCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
