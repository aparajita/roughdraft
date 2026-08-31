import { describe, expect, it } from "vitest";
import { shouldWarnBeforeUnload } from "../src/document-disk-change-state";

describe("beforeunload save warning", () => {
  it.each([
    [{ isDirty: true, saveState: "saved", diskChangeState: "clean" }, true],
    [{ isDirty: false, saveState: "saving", diskChangeState: "clean" }, true],
    [{ isDirty: false, saveState: "unsaved", diskChangeState: "clean" }, true],
    [{ isDirty: false, saveState: "error", diskChangeState: "clean" }, true],
    [{ isDirty: false, saveState: "saved", diskChangeState: "conflict" }, true],
    [{ isDirty: false, saveState: "saved", diskChangeState: "clean" }, false],
  ] as const)("returns %s for %o", (input, expected) => {
    expect(
      shouldWarnBeforeUnload({
        activeDocumentPath: "doc.md",
        ...input,
      }),
    ).toBe(expected);
  });

  it("does not warn when no document is open", () => {
    expect(
      shouldWarnBeforeUnload({
        activeDocumentPath: null,
        isDirty: true,
        saveState: "error",
        diskChangeState: "conflict",
      }),
    ).toBe(false);
  });
});
