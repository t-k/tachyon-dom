import { brotliCompressSync, gzipSync } from "node:zlib";
import type { TemplateExplanation } from "./compiler/explain.js";
import { requireOptionalPeer } from "./optional-peer.js";

export type CodePreviewReport = {
  version: 1;
  input: string;
  source: string;
  generatedJavaScript: string;
  sourceBytes: number;
  generatedJavaScriptBytes: { raw: number; gzip: number; brotli: number };
  explanation: TemplateExplanation;
};

type TypeScriptModule = typeof import("typescript");

const staticRuntimeImports = (code: string): string[] => {
  const ts = requireOptionalPeer<TypeScriptModule>("typescript", "Generated code preview");
  const source = ts.createSourceFile("generated-preview.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    if (specifier.text.startsWith("tachyon-dom/runtime/")) imports.push(specifier.text);
  }
  return [...new Set(imports)];
};

export const createCodePreviewReport = (
  input: string,
  source: string,
  generatedJavaScript: string,
  explanation: TemplateExplanation,
): CodePreviewReport => ({
  version: 1,
  input,
  source,
  generatedJavaScript,
  sourceBytes: Buffer.byteLength(source),
  generatedJavaScriptBytes: {
    raw: Buffer.byteLength(generatedJavaScript),
    gzip: gzipSync(generatedJavaScript).byteLength,
    brotli: brotliCompressSync(generatedJavaScript).byteLength,
  },
  explanation: {
    ...explanation,
    runtimeImports: staticRuntimeImports(generatedJavaScript),
  },
});

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const listHtml = (values: readonly string[]): string =>
  values.length > 0 ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : "<p>None</p>";

export const renderCodePreviewHtml = (report: CodePreviewReport): string => {
  const { explanation, generatedJavaScriptBytes: sizes } = report;
  const regions = explanation.regions.map((region) => {
    const path = region.path.length === 0 ? "root" : `root.${region.path.join(".")}`;
    const reasons = region.reasons.length > 0 ? listHtml(region.reasons) : "<p>Lightweight path selected.</p>";
    return `<li><strong>${escapeHtml(region.kind)} at ${escapeHtml(path)}</strong>: <code>${escapeHtml(region.runtime)}</code>${reasons}</li>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Generated code preview: ${escapeHtml(report.input)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 1600px; margin: 0 auto; padding: 1.5rem; }
  .panes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  .pane { min-width: 0; }
  pre { overflow: auto; padding: 1rem; border: 1px solid #8888; border-radius: .4rem; white-space: pre; tab-size: 2; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  @media (max-width: 800px) { .panes { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>Generated code preview</h1>
<p>Input: <code>${escapeHtml(report.input)}</code></p>
<p>Generated JavaScript source: ${sizes.raw} bytes raw, ${sizes.gzip} bytes gzip, ${sizes.brotli} bytes Brotli. These are source file sizes before bundling and minification.</p>
<div class="panes">
<section class="pane"><h2>Source (.td)</h2><p>${report.sourceBytes} bytes</p><pre tabindex="0"><code>${escapeHtml(report.source)}</code></pre></section>
<section class="pane"><h2>Generated JavaScript</h2><pre tabindex="0"><code>${escapeHtml(report.generatedJavaScript)}</code></pre></section>
</div>
<section><h2>Static runtime imports</h2>${listHtml(explanation.runtimeImports)}</section>
<section><h2>Region choices</h2>${regions.length > 0 ? `<ul>${regions.join("")}</ul>` : "<p>None</p>"}</section>
<section><h2>Hydration diagnostics</h2>${listHtml(explanation.hydrationDiagnostics)}</section>
</body>
</html>
`;
};
