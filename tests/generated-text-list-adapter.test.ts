import { describe, expect, it } from "vitest";
import {
  snapshotGeneratedTextListRows,
  verifyGeneratedTextListOperation,
  verifyGeneratedTextListOracleNegativeCases,
} from "../benchmark/generated-text-list-adapter";

describe("generated text-list benchmark oracle", () => {
  it("rejects skipped update, reorder, append, and remove operations", () => {
    expect(verifyGeneratedTextListOracleNegativeCases(10)).toEqual({
      "update-no-op": true,
      "reorder-no-op": true,
      "append-no-op": true,
      "remove-no-op": true,
    });
  });

  it("checks labels, order, identity, and detached rows after each operation", () => {
    const root = document.createElement("ul");
    root.innerHTML = `<li><span>Row 0</span></li><li><span>Row 1</span></li>`;
    const before = snapshotGeneratedTextListRows(root);
    const first = root.children[0];
    const second = root.children[1];
    if (!first || !second) throw new Error("Missing benchmark rows.");
    root.replaceChildren(second, first);
    const result = verifyGeneratedTextListOperation(
      root,
      [
        { id: 1, label: "Row 1" },
        { id: 0, label: "Row 0" },
      ],
      before,
    );

    expect(result.keys).toEqual([1, 0]);
    expect(result.preservedKeys).toEqual([1, 0]);
    expect(() => verifyGeneratedTextListOperation(root, [{ id: 0, label: "Row 0" }], before)).toThrow(
      /Expected 1 rows after an operation|Unexpected row at index 0/,
    );
  });
});
