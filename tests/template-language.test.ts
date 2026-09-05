import { describe, expect, it } from "vitest";
import {
  createTemplateLanguageFeatures,
  templateCompletionAt,
  templateDefinitionAt,
  templateHoverAt,
  templateRenameAt,
} from "../src/template-language";

const positionAt = (source: string, offset: number): { line: number; character: number } => {
  const lines = source.slice(0, offset).split(/\r?\n/);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
};

describe("Tachyon template language features", () => {
  it("shares script and template symbols for completion and hover", () => {
    const source = `<script lang="ts">\nconst title = "Hello";\nconst ready = true;\n</script>\n<main><if test={ready}><h1>{title}</h1></if></main>`;
    const completion = templateCompletionAt(source, positionAt(source, source.indexOf("{title") + 1));
    const features = createTemplateLanguageFeatures(source, "file:///page.td");
    const hover = templateHoverAt(source, positionAt(source, source.indexOf("title}") + 2));

    expect(completion.map((item) => item.label)).toEqual(expect.arrayContaining(["title", "ready", "if", "for"]));
    expect(hover?.contents.value).toContain("title");
    expect(features.capabilities).toEqual({ completion: true, hover: true, definition: true, rename: true });
  });

  it("resolves a template reference to its script declaration", () => {
    const source = `<script>\nconst title = "Hello";\n</script>\n<main>{title}</main>`;
    const referenceOffset = source.lastIndexOf("title");
    const definition = templateDefinitionAt(source, positionAt(source, referenceOffset + 2), "file:///page.td");

    expect(definition?.uri).toBe("file:///page.td");
    expect(definition?.range.start).toEqual(positionAt(source, source.indexOf("title")));
  });

  it("renames script and template references while preserving unicode positions", () => {
    const source = `<script>\nconst title = "日本語";\n</script>\n<main title={title}>{title}</main>`;
    const rename = templateRenameAt(source, positionAt(source, source.lastIndexOf("title")), "heading");

    expect(rename?.edits).toHaveLength(3);
    expect(rename?.edits.every((edit) => edit.newText === "heading")).toBe(true);
  });
});
