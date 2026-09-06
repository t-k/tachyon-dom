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

const applyEdits = (source: string, edits: readonly { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]): string =>
  [...edits]
    .sort((left, right) => right.range.start.line - left.range.start.line || right.range.start.character - left.range.start.character)
    .reduce((value, edit) => {
      const offsetOf = (position: { line: number; character: number }): number =>
        value.split(/\r?\n/).slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
      return value.slice(0, offsetOf(edit.range.start)) + edit.newText + value.slice(offsetOf(edit.range.end));
    }, source);

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

  it("renames only lexical references and leaves strings, comments, properties, and shadowed locals unchanged", () => {
    const source = `<script>
const title = "title";
const object = { title: "property", value: title };
// title
function local() { const title = "local"; return title; }
</script>
<main><p>{title}</p></main>`;
    const rename = templateRenameAt(source, positionAt(source, source.lastIndexOf("{title") + 2), "heading");
    expect(rename).toBeDefined();
    const rewritten = [...(rename?.edits ?? [])]
      .sort((left, right) => right.range.start.line - left.range.start.line || right.range.start.character - left.range.start.character)
      .reduce((value, edit) => {
        const start = value.split(/\r?\n/).slice(0, edit.range.start.line).reduce((total, line) => total + line.length + 1, 0) + edit.range.start.character;
        const end = value.split(/\r?\n/).slice(0, edit.range.end.line).reduce((total, line) => total + line.length + 1, 0) + edit.range.end.character;
        return value.slice(0, start) + edit.newText + value.slice(end);
      }, source);

    expect(rewritten).toContain(`const heading = "title"`);
    expect(rewritten).toContain(`title: "property"`);
    expect(rewritten).toContain(`const title = "local"`);
    expect(rewritten).toContain(`return title`);
    expect(rewritten).toContain(`{heading}</p>`);
    expect(rewritten).toContain(`value: heading`);
  });

  it("resolves a for alias definition in its lexical template scope", () => {
    const source = `<script>const row = 1;</script><ul><for each={rows} as="row" key={row.id}><li>{row.name}</li></for></ul>`;
    const reference = source.indexOf("row.name");
    const definition = templateDefinitionAt(source, positionAt(source, reference + 1), "file:///page.td");

    expect(definition?.range.start).toEqual(positionAt(source, source.indexOf(`as="row"`) + 4));
  });

  it("renames a for alias together with its key expression and resolves key references to the alias", () => {
    const source = `<script>const row = 1;</script><ul><for each={rows} as="row" key={row.id}><li>{row.name}</li></for></ul>`;
    const rename = templateRenameAt(source, positionAt(source, source.indexOf("row.name") + 1), "entry");
    expect(rename).toBeDefined();
    expect(applyEdits(source, rename?.edits ?? [])).toBe(
      `<script>const row = 1;</script><ul><for each={rows} as="entry" key={entry.id}><li>{entry.name}</li></for></ul>`,
    );

    const keyDefinition = templateDefinitionAt(source, positionAt(source, source.indexOf("key={row") + 5), "file:///page.td");
    expect(keyDefinition?.range.start).toEqual(positionAt(source, source.indexOf(`as="row"`) + 4));
  });

  it("resolves the for each expression in the outer scope and an implicit key alias in the row scope", () => {
    const source = `<script>const rows = [];</script><ul><for each={rows} key={row.id}><li>{row.name}</li></for></ul>`;
    const eachDefinition = templateDefinitionAt(source, positionAt(source, source.indexOf("each={rows") + 6), "file:///page.td");
    expect(eachDefinition?.range.start).toEqual(positionAt(source, source.indexOf("const rows") + 6));

    const rename = templateRenameAt(source, positionAt(source, source.indexOf("row.name") + 1), "entry");
    expect(applyEdits(source, rename?.edits ?? [])).toBe(
      `<script>const rows = [];</script><ul><for each={rows} key={entry.id}><li>{entry.name}</li></for></ul>`,
    );
  });

  it("does not rename function parameters that shadow the outer binding", () => {
    const source = `<script>const title="outer";function f(title){return title;}const g=(title: string)=>title;const h=title=>title.length;const k=(x)=>{const title=x;return title;};</script><p>{title}</p>`;
    const rename = templateRenameAt(source, positionAt(source, source.lastIndexOf("{title") + 2), "heading");
    expect(rename).toBeDefined();
    expect(applyEdits(source, rename?.edits ?? [])).toBe(
      `<script>const heading="outer";function f(title){return title;}const g=(title: string)=>title;const h=title=>title.length;const k=(x)=>{const title=x;return title;};</script><p>{heading}</p>`,
    );

    const parameterDefinition = templateDefinitionAt(source, positionAt(source, source.indexOf("return title") + 8), "file:///page.td");
    expect(parameterDefinition?.range.start).toEqual(positionAt(source, source.indexOf("f(title") + 2));
  });

  it("keeps default value expressions in parameter lists bound to the outer scope", () => {
    const source = `<script>const fallback = 1;const f = ({ a = fallback, b: [c = fallback] }) => a + c + fallback;const g = (x = fallback, y: number = fallback) => x + y;</script><p>{fallback}</p>`;
    const rename = templateRenameAt(source, positionAt(source, source.lastIndexOf("{fallback") + 2), "initial");
    expect(applyEdits(source, rename?.edits ?? [])).toBe(
      `<script>const initial = 1;const f = ({ a = initial, b: [c = initial] }) => a + c + initial;const g = (x = initial, y: number = initial) => x + y;</script><p>{initial}</p>`,
    );
  });
});
