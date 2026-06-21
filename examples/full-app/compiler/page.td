<script>
import { compiledDiagnosticTemplate, copy, generatedClient, templateSource } from "../app";
import { renderServerTemplate } from "../../../src/compiler";

export const scope = ({ rows, streamOutput }) => ({
  copy: copy(),
  generatedClient,
  streamOutput: streamOutput ?? renderServerTemplate(compiledDiagnosticTemplate, { rows, title: "Compiled stream" }),
  templateSource,
});
</script>
<section class="page-grid diagnostics-grid">
  <article class="panel">
    <h2>{copy.template}</h2>
    <pre class="code" data-testid="compiled-template">{templateSource}</pre>
  </article>
  <article class="panel">
    <h2>{copy.streamOutput}</h2>
    <pre class="code" data-testid="stream-output">{streamOutput}</pre>
  </article>
  <article class="panel wide-panel">
    <h2>{copy.generatedClient}</h2>
    <pre class="code" data-testid="generated-client">{generatedClient}</pre>
  </article>
</section>
