import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateClientModule, generateServerStreamModule } from "../src/compiler";
import { compileTachyonSfc, transformSfcScript } from "../src/compiler/sfc";
import { renderToResponse } from "../src/server/stream";

type ExampleScope = {
  initialCount: number;
  count: number;
  islandId: string;
};

type GeneratedServerModule = {
  stream: (scope: ExampleScope) => AsyncIterable<string>;
};

const source = readFileSync(join(process.cwd(), "examples", "store-hydrate-stream.td"), "utf8").trim();
const compiledResult = compileTachyonSfc(source);

if (!compiledResult.ok) {
  throw new Error(compiledResult.error.message);
}

const compiled = compiledResult.value.template;

const importExampleScope = async (): Promise<ExampleScope> => {
  const script = transformSfcScript(compiledResult.value.descriptor.script);
  if (!script.code) {
    return { count: 7, initialCount: 7, islandId: "counter-panel" };
  }
  const encoded = Buffer.from(script.code).toString("base64");
  const module = (await import(`data:text/javascript;base64,${encoded}`)) as {
    default?: ExampleScope;
    scope?: ExampleScope;
  };
  return module.scope ?? module.default ?? { count: 7, initialCount: 7, islandId: "counter-panel" };
};

export const generatedClientModule = generateClientModule(compiled, { reactive: true });
export const generatedServerStreamModule = generateServerStreamModule(compiled);
const scope = await importExampleScope();

const importGeneratedServerModule = async (): Promise<GeneratedServerModule> => {
  const encoded = Buffer.from(generatedServerStreamModule).toString("base64");
  return (await import(`data:text/javascript;base64,${encoded}`)) as GeneratedServerModule;
};

export const renderExampleResponse = async (): Promise<Response> => {
  const { stream } = await importGeneratedServerModule();
  return renderToResponse(stream(scope));
};

export const renderExampleHtml = async (): Promise<string> => {
  const response = await renderExampleResponse();
  return response.text();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await renderExampleHtml());
}
