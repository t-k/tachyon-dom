import { describe, expect, it } from "vitest";
import { compileTemplate, explainCompiledTemplate, formatTemplateExplanation } from "../src/compiler";

const compile = (source: string) => {
  const result = compileTemplate(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("explainCompiledTemplate", () => {
  it("reports the text-only list runtime for rows with text bindings only", () => {
    const explanation = explainCompiledTemplate(
      compile(`<ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul>`),
    );
    expect(explanation.regions).toEqual([
      expect.objectContaining({
        kind: "list",
        path: [],
        runtime: "tachyon-dom/runtime/list-text",
        reasons: [],
      }),
    ]);
  });

  it("explains why a list needs the generic runtime", () => {
    const explanation = explainCompiledTemplate(
      compile(`<ul><for each={rows} key={row.id}><li><input bind:value={row.label} /></li></for></ul>`),
    );
    const [region] = explanation.regions;
    expect(region?.runtime).toBe("tachyon-dom/runtime/list");
    expect(region?.reasons.join(" ")).toMatch(/bind:/);
  });

  it("explains conditional-core versus generic conditional", () => {
    const light = explainCompiledTemplate(compile(`<main><if test={open}><p>{label}</p></if></main>`));
    expect(light.regions[0]).toEqual(
      expect.objectContaining({ kind: "conditional", runtime: "tachyon-dom/runtime/conditional-core", reasons: [] }),
    );
    const heavy = explainCompiledTemplate(
      compile(`<main><if test={open}><ul><for each={rows} key={row.id}><li>{row.label}</li></for></ul></if></main>`),
    );
    expect(heavy.regions[0]).toEqual(
      expect.objectContaining({ kind: "conditional", runtime: "tachyon-dom/runtime/conditional" }),
    );
    expect(heavy.regions[0]?.reasons.join(" ")).toMatch(/<for each=/);
    expect(heavy.regions.map((region) => region.kind)).toEqual(["conditional", "list"]);
  });

  it("lists the runtime modules a client module imports", () => {
    const explanation = explainCompiledTemplate(compile(`<main><button on:click={inc}>{count}</button></main>`));
    expect(explanation.runtimeImports).toEqual(
      expect.arrayContaining(["tachyon-dom/runtime/text", "tachyon-dom/runtime/event"]),
    );
    expect(explanation.runtimeImports).not.toContain("tachyon-dom/runtime/list");
  });

  it("surfaces compile-time hydration diagnostics", () => {
    const explanation = explainCompiledTemplate(
      compile(
        `<ul><for each={rows} key={row.id}><li>{row.label}</li></for><if test={loading}><li>Loading</li></if></ul>`,
      ),
    );
    expect(Array.isArray(explanation.hydrationDiagnostics)).toBe(true);
  });

  it("formats a readable report", () => {
    const text = formatTemplateExplanation(
      explainCompiledTemplate(
        compile(`<ul><for each={rows} key={row.id}><li><input bind:value={row.label} /></li></for></ul>`),
      ),
    );
    expect(text).toContain("<for> under root uses");
    expect(text).toContain("tachyon-dom/runtime/list");
    expect(text).toContain("bind:");
  });
});
