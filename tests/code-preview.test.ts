import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createCodePreviewReport, renderCodePreviewHtml } from "../src/code-preview";

describe("generated code preview", () => {
  it("reports generated source sizes and compiler runtime decisions", () => {
    const source = `<ul><for each={rows} key={row.id}><li>{row.name}</li></for></ul>`;
    const generatedJavaScript = `// from "tachyon-dom/runtime/fake"\nimport { mountGeneratedTextKeyedList } from "tachyon-dom/runtime/list-text";\nimport { createTemplateComponent } from "tachyon-dom/runtime/component";`;
    const report = createCodePreviewReport("page.td", source, generatedJavaScript, {
      regions: [{ kind: "list", path: [0], runtime: "tachyon-dom/runtime/list-text", reasons: [] }],
      runtimeImports: ["stale-plan-import"],
      hydrationDiagnostics: [],
    });

    expect(report.version).toBe(1);
    expect(report.sourceBytes).toBe(Buffer.byteLength(source));
    expect(report.generatedJavaScriptBytes).toEqual({
      raw: Buffer.byteLength(generatedJavaScript),
      gzip: gzipSync(generatedJavaScript).byteLength,
      brotli: brotliCompressSync(generatedJavaScript).byteLength,
    });
    expect(report.explanation.runtimeImports).toEqual([
      "tachyon-dom/runtime/list-text",
      "tachyon-dom/runtime/component",
    ]);
    expect(report.explanation.regions[0]?.runtime).toBe("tachyon-dom/runtime/list-text");
  });

  it("renders source and generated JavaScript side by side without interpreting template content as HTML", () => {
    const report = createCodePreviewReport(
      `bad</h1><script>alert(1)</script>.td`,
      `<main title="A & B"><script>alert("source")</script></main>`,
      `import "tachyon-dom/runtime/side-effect";\nimport { a } from "tachyon-dom/runtime/conditional";\nimport { b } from  "tachyon-dom/runtime/text";\nconst generated = "</pre><script>alert('generated')</script>";`,
      {
        regions: [
          { kind: "conditional", path: [0, 1], runtime: "tachyon-dom/runtime/conditional", reasons: ["a ref"] },
        ],
        runtimeImports: ["tachyon-dom/runtime/conditional", "tachyon-dom/runtime/text"],
        hydrationDiagnostics: ["Cannot hydrate <await>"],
      },
    );

    const html = renderCodePreviewHtml(report);

    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("Source (.td)");
    expect(html).toContain("Generated JavaScript");
    expect(html.match(/<pre tabindex="0">/g)).toHaveLength(2);
    expect(html).toContain("tachyon-dom/runtime/conditional");
    expect(html).toContain(
      "<li>tachyon-dom/runtime/side-effect</li><li>tachyon-dom/runtime/conditional</li><li>tachyon-dom/runtime/text</li>",
    );
    expect(html).not.toContain("<li>tachyon-dom/runtime/fake</li>");
    expect(html).toContain("conditional at root.0.1");
    expect(html).toContain("<li>a ref</li>");
    expect(html).toContain("Cannot hydrate &lt;await&gt;");
    expect(html).toContain("&lt;script&gt;alert(&quot;source&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("&#39;generated&#39;");
    expect(html).not.toContain("<script>alert(");
  });

  it("labels root regions and empty sections without inventing runtime imports", () => {
    const report = createCodePreviewReport("static.td", "<main>Hello</main>", "export {};", {
      regions: [{ kind: "conditional", path: [], runtime: "tachyon-dom/runtime/conditional-core", reasons: [] }],
      runtimeImports: [],
      hydrationDiagnostics: [],
    });

    const html = renderCodePreviewHtml(report);

    expect(html).toContain("<strong>conditional at root</strong>");
    expect(html).toContain("<p>Lightweight path selected.</p>");
    expect(html.match(/<p>None<\/p>/g)).toHaveLength(2);
    expect(html).not.toContain("<li></li>");
  });

  it("includes static re-exports once while ignoring strings, comments, and dynamic imports", () => {
    const code = `// import "tachyon-dom/runtime/comment"\nconst note = 'from "tachyon-dom/runtime/string"';\nimport { local } from "./local.js";\nexport { something } from "tachyon-dom/runtime/signal";\nexport * from "tachyon-dom/runtime/signal";\nvoid import("tachyon-dom/runtime/lazy");`;
    const report = createCodePreviewReport("imports.td", "<main></main>", code, {
      regions: [],
      runtimeImports: [],
      hydrationDiagnostics: [],
    });

    expect(report.explanation.runtimeImports).toEqual(["tachyon-dom/runtime/signal"]);
  });
});
