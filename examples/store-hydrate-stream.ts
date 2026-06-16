import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { compileTemplate, generateClientModule, generateServerStreamModule } from "../src/compiler";
import { renderToResponse } from "../src/server/stream";

type ExampleScope = {
  initialCount: number;
  count: number;
  islandId: string;
};

type GeneratedServerModule = {
  stream: (scope: ExampleScope) => AsyncIterable<string>;
};

const source = `<main><store count={initialCount}/><h1>Tachyon streaming example</h1><section hydrate:id={islandId}><button>{count}</button></section></main>`;
const compiledResult = compileTemplate(source);

if (compiledResult.isErr()) {
  throw new Error(compiledResult.error.message);
}

const compiled = compiledResult.value;
const scope = {
  initialCount: 7,
  count: 7,
  islandId: "counter-panel",
};

export const generatedClientModule = generateClientModule(compiled, { reactive: true });
export const generatedServerStreamModule = generateServerStreamModule(compiled);

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
