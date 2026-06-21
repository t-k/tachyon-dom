<script>
import * as demo from "./demo.td";
import templateSource from "./demo.td?raw";
import * as shell from "./shell.td";
import shellSource from "./shell.td?raw";
import { generateClientModule, generateServerStreamModule, renderServerTemplate } from "../../src/compiler";
import { compileTachyonSfc } from "../../src/compiler/sfc";
import { serializeHydrationState } from "../../src/runtime/hydrate";
import { readTextStreamChunks } from "../../src/runtime/stream-client";
import { renderToReadableStream } from "../../src/server/stream";

const compiledResult = compileTachyonSfc(templateSource);
if (!compiledResult.ok) {
  throw new Error(compiledResult.error.message);
}

const compiled = compiledResult.value.template;
const listBinding = compiled.client.bindings.find((binding) => binding.kind === "list");
if (!listBinding) {
  throw new Error("Example template must include a keyed list.");
}
const rowBindings = listBinding.bindings.filter(
  (binding) => binding.kind === "text" || binding.kind === "class" || binding.kind === "event",
);

const generatedServerStreamModule = generateServerStreamModule(compiled);
const generatedClientModule = generateClientModule(compiled, { reactive: true });
const shellResult = compileTachyonSfc(shellSource);
if (!shellResult.ok) {
  throw new Error(shellResult.error.message);
}
const shellTemplate = shellResult.value.template;

const encodeBase64 = (value) => btoa(value);

const importGeneratedServerModule = async () =>
  await import(/* @vite-ignore */ `data:text/javascript;base64,${encodeBase64(generatedServerStreamModule)}`);

const renderChunkList = (chunks) =>
  chunks
    .map((chunk, index) => {
      const element = document.createElement("div");
      const indexElement = document.createElement("strong");
      element.className = "chunk";
      indexElement.textContent = String(index + 1);
      element.append(indexElement, " ", chunk);
      return element.outerHTML;
    })
    .join("");

const renderShell = () =>
  renderServerTemplate(shellTemplate, {
    compilerIr: JSON.stringify(compiled.ir.directives, null, 2),
    generatedClientModule,
    templateSource,
  });

export const mountWebExample = async (app) => {
  app.innerHTML = renderShell();
  const preview = app.querySelector("#preview");
  const chunksTarget = app.querySelector("#chunks");
  if (!(preview instanceof HTMLElement) || !(chunksTarget instanceof HTMLElement)) {
    throw new Error("Example shell failed to mount.");
  }

  const render = async () => {
    const scope = demo.initialScope();
    const { stream } = await importGeneratedServerModule();
    const chunks = await readTextStreamChunks(renderToReadableStream(stream(scope)));
    preview.innerHTML =
      chunks.join("") + serializeHydrationState(scope.islandId, { count: scope.count, rows: scope.rows });
    chunksTarget.innerHTML = renderChunkList(chunks);
    demo.bindPreview(preview, scope, { compiled, listBinding, rowBindings });
  };

  shell.bindShellControls(app, render);

  await render();
};
</script>
