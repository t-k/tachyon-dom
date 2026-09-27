import { describe, expect, it } from "vitest";
import { checkTachyonAccessibility, formatAccessibilityDiagnostic } from "../src/accessibility";
import { diagnosticsForTachyonDocument } from "../src/language-server";

describe("static accessibility diagnostics", () => {
  it("maps findings in an SFC and distinguishes definite gaps from runtime questions", () => {
    const source = `<script setup lang="ts">const description = "Chart";</script>
<main><img src="a.png"><img src="b.png" alt=""><img src="c.png" alt={description}><input id="email"><button></button></main>`;
    const result = checkTachyonAccessibility(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId, confidence }) => [ruleId, confidence])).toEqual([
      ["img-alt", "certain"],
      ["img-alt-dynamic", "needs-review"],
      ["control-name", "needs-review"],
      ["button-name", "needs-review"],
    ]);
    expect(result.value.map(({ offset }) => source.slice(offset, offset + 7))).toEqual([
      "<img sr",
      "<img sr",
      "<input ",
      "<button",
    ]);
    expect(result.value[0]).toMatchObject({ line: 2, column: 7 });
    expect(formatAccessibilityDiagnostic(result.value[0]!, "page.td")).toContain(
      "page.td:2:7: a11y img-alt (certain):",
    );
  });

  it("accepts explicit and implicit labels, ARIA names, and decorative image alternatives", () => {
    const source = `<main><label for="email">Email</label><input id="email"><label>Name<input></label><input aria-label="Search"><select title="Country"></select><textarea aria-labelledby="note"></textarea><img alt=""><button>Save</button></main>`;
    const result = checkTachyonAccessibility(source);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("asks for review when an image without alt is hidden from the accessibility tree", () => {
    const result = checkTachyonAccessibility(
      `<main><img src="x" aria-hidden="true"><img src="y" role="presentation"></main>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId, confidence }) => [ruleId, confidence])).toEqual([
      ["img-alt", "needs-review"],
      ["img-alt", "needs-review"],
    ]);
  });

  it("does not treat placeholder or an unrelated label as a control name", () => {
    const source = `<main><label for="other">Other</label><input id="email" placeholder="Email"><input type="hidden"><input type="submit" value="Save"></main>`;
    const result = checkTachyonAccessibility(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId }) => ruleId)).toEqual(["control-name"]);
  });

  it("does not count an empty label, an empty ARIA name, or a decorative icon as a name", () => {
    const source = `<main><label for="email"></label><input id="email" aria-label=""><button><img src="icon.svg" alt=""></button><button><img src="save.svg" alt="Save"></button></main>`;
    const result = checkTachyonAccessibility(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId }) => ruleId)).toEqual(["control-name", "button-name"]);
  });

  it("checks image submit buttons separately from text inputs", () => {
    const source = `<main><input type="image" src="go.png"><input type="image" src="save.png" alt="Save"><input type="image" src="search.png" alt={actionName}></main>`;
    const result = checkTachyonAccessibility(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId, confidence }) => [ruleId, confidence])).toEqual([
      ["input-image-name", "certain"],
      ["input-image-name", "needs-review"],
    ]);
  });

  it("keeps dynamic names as review findings and ignores hidden button content", () => {
    const source = `<main><label for="x">{label}</label><input id="x"><input aria-label={label}><button aria-label={label}></button><button>{label}</button><button><span aria-hidden="true">X</span></button><input type="button"><input type="button" value="Save"></main>`;
    const result = checkTachyonAccessibility(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId, confidence }) => [ruleId, confidence])).toEqual([
      ["control-name", "needs-review"],
      ["control-name", "needs-review"],
      ["button-name", "needs-review"],
      ["button-name", "needs-review"],
      ["button-name", "needs-review"],
      ["button-name", "needs-review"],
    ]);
  });

  it("reviews names provided only by conditional or inserted content", () => {
    const result = checkTachyonAccessibility(
      `<main><button><if test={visible}>Save</if></button><button><slot /></button></main>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId }) => ruleId)).toEqual(["button-name", "button-name"]);
  });

  it("does not assume a conditional label exists for a control outside the branch", () => {
    const result = checkTachyonAccessibility(
      `<main><if test={shown}><label for="x">Email</label></if><input id="x"></main>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId, confidence }) => [ruleId, confidence])).toEqual([
      ["control-name", "needs-review"],
    ]);
  });

  it("uses static name fallback while reviewing dynamic visibility and input button values", () => {
    const source = `<main><button><span aria-hidden={hidden}>Save</span></button><button>Save {count}</button><input type="button" value={action}><input type="image" alt="" aria-label="Search"><input type="image" alt={action} aria-label="Search"></main>`;
    const result = checkTachyonAccessibility(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map(({ ruleId, confidence }) => [ruleId, confidence])).toEqual([
      ["button-name", "needs-review"],
      ["button-name", "needs-review"],
    ]);
  });

  it("keeps source ranges and rejects malformed templates", () => {
    const source = `<main>\n  <img src="x">\n</main>`;
    const result = checkTachyonAccessibility(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value[0]).toMatchObject({ offset: source.indexOf("<img"), endOffset: source.indexOf("<img") + 13 });
    expect(formatAccessibilityDiagnostic(result.value[0]!, "page.td")).toContain(`\n  <img src="x">\n  ^`);
    expect(checkTachyonAccessibility("<main><if></if></main>")).toMatchObject({ ok: false });
    expect(checkTachyonAccessibility(`<script setup>const value = 1;</script>`)).toEqual({ ok: true, value: [] });
  });

  it("shows review findings in the language server without turning them into compile errors", () => {
    const diagnostics = diagnosticsForTachyonDocument(`<main><img src="x"><input></main>`);
    expect(diagnostics.map(({ code, severity, source }) => [code, severity, source])).toEqual([
      ["img-alt", 2, "tachyon-dom/a11y"],
      ["control-name", 3, "tachyon-dom/a11y"],
    ]);
  });
});
