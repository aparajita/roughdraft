import { parseDocument, RecordIdAllocator } from "@roughdraft/rfm";
import { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import {
  createEditorExtensions,
  type SuggestionAttrs,
  type SuggestionKind,
} from "./editor-extensions";
import { createSuggestion, editorStateToReviewMarkdown } from "./review";
import {
  applySuggestedInput,
  applySuggestedRemoval,
  resolveRemovalRange,
  segmentSuggestedRange,
} from "./suggesting-mode";

const SUGGESTION_TIMESTAMP = "2026-08-28T12:00:00.000Z";

let ids = new RecordIdAllocator(parseDocument(""));

/**
 * Attributes for a fresh suggestion mark, minted the way the app mints them so
 * that these tests and production cannot disagree about what an allocation
 * returns. Only the timestamp is fixed, because it is the one field the app
 * takes from the clock.
 */
function suggestionAttrs(kind: SuggestionKind): SuggestionAttrs {
  return {
    ...createSuggestion(kind, undefined, { ids }),
    createdAt: SUGGESTION_TIMESTAMP,
  };
}

/**
 * Helper: build a tiptap Editor in JSDOM with the standard Roughdraft
 * extensions. Returns the editor after `onCreate` has fired.
 *
 * The allocator is seeded from the fixture, as the app seeds it from the
 * document being reviewed. An anchor is inline HTML in markdown either way, so
 * `reserve` reads the fixture's own ids and will not hand one of them back.
 */
function createTestEditor(html?: string): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  ids = new RecordIdAllocator(parseDocument(html ?? ""));

  return new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: html,
  });
}

/**
 * Remove `[from, to)` as suggesting mode does, and leave the caret where the
 * key that asked for the removal leaves it.
 */
function dispatchSuggestedRemoval(
  editor: Editor,
  from: number,
  to: number,
  caretAt: "from" | "to",
) {
  if (from === to) return;

  const { state } = editor.view;
  const tr = state.tr;

  applySuggestedRemoval(
    state,
    tr,
    segmentSuggestedRange(state, from, to),
    suggestionAttrs,
  );
  tr.setSelection(
    TextSelection.create(
      tr.doc,
      tr.mapping.map(caretAt === "from" ? from : to, -1),
    ),
  );
  tr.scrollIntoView();
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate one character of text input at a collapsed caret.
 */
function suggestingTypeChar(editor: Editor, char: string) {
  const { state } = editor.view;
  const { selection } = state;

  if (!selection.empty) {
    throw new Error("suggestingTypeChar does not support range selections");
  }

  const tr = state.tr;

  applySuggestedInput(
    state,
    tr,
    selection.from,
    selection.to,
    char,
    suggestionAttrs,
  );
  editor.view.dispatch(tr);
}

/** Helper: simulate a Backspace press in suggesting mode. */
function suggestingBackspace(editor: Editor) {
  const { from, to } = resolveRemovalRange(
    editor.view.state,
    "backward",
    "character",
  );

  dispatchSuggestedRemoval(editor, from, to, "from");
}

/** Helper: simulate Ctrl+Backspace (word-delete backward). */
function suggestingCtrlBackspace(editor: Editor) {
  const { from, to } = resolveRemovalRange(
    editor.view.state,
    "backward",
    "word",
  );

  dispatchSuggestedRemoval(editor, from, to, "from");
}

/** Helper: simulate Ctrl+Delete (word-delete forward). */
function suggestingCtrlDelete(editor: Editor) {
  const { from, to } = resolveRemovalRange(
    editor.view.state,
    "forward",
    "word",
  );

  dispatchSuggestedRemoval(editor, from, to, "to");
}

/**
 * Helper: simulate Cut (Ctrl+X) in suggesting mode. Cut leaves the selection
 * alone, so it does not go through `dispatchSuggestedRemoval`.
 */
function suggestingCut(editor: Editor) {
  const { state } = editor.view;
  const { selection } = state;

  if (selection.empty) return;

  const tr = state.tr;

  applySuggestedRemoval(
    state,
    tr,
    segmentSuggestedRange(state, selection.from, selection.to),
    suggestionAttrs,
  );
  editor.view.dispatch(tr.scrollIntoView());
}

/** Helper: select the first occurrence of `text` in a single-paragraph doc. */
function selectText(editor: Editor, text: string) {
  const { doc } = editor.state;
  const start = doc.textBetween(0, doc.content.size, "\n").indexOf(text);

  if (start < 0) throw new Error(`Editor does not contain ${text}`);

  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(doc, start + 1, start + text.length + 1),
    ),
  );
}

/**
 * Helper: simulate the menu's Suggest deletion action, which removes the
 * selection and leaves the caret where it is.
 */
function suggestMenuDeletion(editor: Editor) {
  const { state } = editor.view;
  const { from, to } = state.selection;
  const tr = state.tr;

  applySuggestedRemoval(
    state,
    tr,
    segmentSuggestedRange(state, from, to),
    suggestionAttrs,
  );
  editor.view.dispatch(tr);
}

/** Helper: simulate typing over a range selection in suggesting mode. */
function suggestingTypeWithSelection(editor: Editor, text: string) {
  const { state } = editor.view;
  const { selection } = state;
  const tr = state.tr;

  applySuggestedInput(
    state,
    tr,
    selection.from,
    selection.to,
    text,
    suggestionAttrs,
  );
  editor.view.dispatch(tr.scrollIntoView());
}

function getMarks(editor: Editor): Array<{ text: string; kind: string }> {
  const marks: Array<{ text: string; kind: string }> = [];

  editor.state.doc.descendants((node) => {
    if (!node.isText) return;

    for (const mark of node.marks) {
      if (mark.type.name === "suggestion") {
        marks.push({ text: node.text ?? "", kind: mark.attrs.kind as string });
      }
    }
  });

  return marks;
}

function markKinds(editor: Editor): string[] {
  return getMarks(editor).map((mark) => mark.kind);
}

/** The suggestion id on every text run carrying a mark of `kind`, in order. */
function suggestionIdsOfKind(editor: Editor, kind: string): string[] {
  const suggestionIds: string[] = [];

  editor.state.doc.descendants((node) => {
    if (!node.isText) return;

    for (const mark of node.marks) {
      if (mark.type.name === "suggestion" && mark.attrs.kind === kind) {
        suggestionIds.push(mark.attrs.suggestionId as string);
      }
    }
  });

  return suggestionIds;
}

describe("suggesting mode type-over inside an insertion", () => {
  it("should replace inserted text in-place when typing over a selection that is entirely within an insertion", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );

    for (const char of " threr") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello threr world");

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 9, 12),
      ),
    );

    suggestingTypeWithSelection(editor, "ere");

    expect(editor.state.doc.textContent).toBe("Hello there world");

    const kinds = markKinds(editor);
    expect(kinds).not.toContain("replace-old");
    expect(kinds).not.toContain("replace-new");
    expect(kinds).toContain("insert");

    editor.destroy();
  });

  it("should still create a replacement when typing over original text", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 7, 12),
      ),
    );

    suggestingTypeWithSelection(editor, "planet");

    expect(editor.state.doc.textContent).toBe("Hello worldplanet");

    const kinds = markKinds(editor);
    expect(kinds).toContain("replace-old");
    expect(kinds).toContain("replace-new");

    editor.destroy();
  });
});

describe("suggesting mode backspace inside an insertion", () => {
  it("should delete the last character of a suggested insertion rather than marking it as a deletion", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor at end of "Hello" (position 6 in ProseMirror)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );

    // Type " there" in suggesting mode → creates an insert mark
    for (const char of " there") {
      suggestingTypeChar(editor, char);
    }

    expect(markKinds(editor)).toContain("insert");

    // The full text should now be "Hello there world"
    expect(editor.state.doc.textContent).toBe("Hello there world");

    // Now press Backspace — this should delete "e" from the insertion,
    // leaving "Hello ther world" with the "insert" mark on " ther"
    suggestingBackspace(editor);

    // Correct behaviour: "e" is simply removed because it was part of the
    // user's own suggested insertion — it was never committed content.
    expect(editor.state.doc.textContent).toBe("Hello ther world");
    expect(markKinds(editor)).not.toContain("delete");

    editor.destroy();
  });

  it("should still mark original text as a deletion when backspacing", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor after "Hello " (position 7)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)),
    );

    // Backspace on original text → should create a delete mark
    suggestingBackspace(editor);

    // The text content stays the same (delete marks don't remove text)
    expect(editor.state.doc.textContent).toBe("Hello world");
    expect(markKinds(editor)).toContain("delete");

    editor.destroy();
  });

  it("should fully remove a suggested insertion when all characters are backspaced", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );

    // Type "X" in suggesting mode
    suggestingTypeChar(editor, "X");
    expect(editor.state.doc.textContent).toBe("HelloX world");

    // Backspace "X" — should completely remove it
    suggestingBackspace(editor);
    expect(editor.state.doc.textContent).toBe("Hello world");
    expect(getMarks(editor)).toHaveLength(0);

    editor.destroy();
  });
});

describe("word delete should not cross paragraph boundaries", () => {
  it("should not mark text from the previous paragraph when Ctrl+Backspace is pressed at the start of a paragraph", () => {
    const editor = createTestEditor(
      "<p>First paragraph</p><p>Second paragraph</p>",
    );

    // Place cursor at the start of "Second paragraph"
    // Doc structure: <doc><p>First paragraph</p><p>Second paragraph</p></doc>
    // Position 1: start of first paragraph
    // Position 16: end of "First paragraph" (15 chars)
    // Position 17: after first paragraph close
    // Position 18: start of second paragraph content
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 18)),
    );

    // Ctrl+Backspace should not reach into the first paragraph
    suggestingCtrlBackspace(editor);

    // The first paragraph should be untouched — no delete marks
    const marks = getMarks(editor);
    const firstParagraphDeletions = marks.filter(
      (mark) => mark.kind === "delete" && "First paragraph".includes(mark.text),
    );
    expect(firstParagraphDeletions).toHaveLength(0);

    editor.destroy();
  });

  it("should not mark text from the next paragraph when Ctrl+Delete is pressed at the end of a paragraph", () => {
    const editor = createTestEditor(
      "<p>First paragraph</p><p>Second paragraph</p>",
    );

    // Place cursor at the end of "First paragraph" (position 16)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 16)),
    );

    // Ctrl+Delete should not reach into the second paragraph
    suggestingCtrlDelete(editor);

    // The second paragraph should be untouched — no delete marks
    const marks = getMarks(editor);
    const secondParagraphDeletions = marks.filter(
      (mark) =>
        mark.kind === "delete" && "Second paragraph".includes(mark.text),
    );
    expect(secondParagraphDeletions).toHaveLength(0);

    editor.destroy();
  });
});

describe("Cut in suggesting mode should delete inserted text, not mark it", () => {
  it("should truly delete inserted text when cutting a selection that includes it", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor at end of "Hello" and type " new" as a suggestion
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select " new" (positions 6..10 — the inserted text)
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 6, 10),
      ),
    );

    // Cut — inserted text should be deleted, not marked as a deletion
    suggestingCut(editor);

    expect(editor.state.doc.textContent).toBe("Hello world");
    expect(markKinds(editor)).not.toContain("delete");

    editor.destroy();
  });

  it("should mark original text as deleted and remove inserted text in a mixed selection", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Type " new" after "Hello"
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select "o new w" — includes original "o", inserted " new", and original " w"
    // In the doc: "Hello new world"
    //              ^    ^^^^
    // Position 5 = "o", positions 6-9 = " new" (inserted), position 10 = " ", position 11 = "w"
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 5, 12),
      ),
    );

    suggestingCut(editor);

    // Inserted text " new" is removed; "o" and " w" are marked deleted
    const kinds = markKinds(editor);
    expect(kinds).not.toContain("insert");
    expect(kinds).toContain("delete");

    editor.destroy();
  });

  it("should give each original run its own suggestion id", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }

    // "o", the inserted " new", and " w": the insertion separates two runs of
    // original text, so the removal is two deletions rather than one.
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 5, 12),
      ),
    );

    suggestingCut(editor);

    const deletionIds = suggestionIdsOfKind(editor, "delete");

    // An id is an element id in the written document, where it MUST be unique.
    expect(deletionIds).toHaveLength(2);
    expect(new Set(deletionIds).size).toBe(deletionIds.length);

    editor.destroy();
  });
});

describe("removing the new half of a replacement", () => {
  /**
   * A replacement is one suggestion in two halves under one id, and a half with
   * no partner cannot be written at all — the save keeps its text as prose and
   * drops the record. Taking the proposed text back therefore has to leave the
   * suggestion the reviewer still holds: the deletion of the original text. The
   * check is on the written document, because losing the record is what the
   * reviewer would have paid for it.
   */
  it("leaves a plain deletion of the original text that survives a save", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 7, 12),
      ),
    );
    suggestingTypeWithSelection(editor, "planet");
    expect(editor.state.doc.textContent).toBe("Hello worldplanet");

    // "planet", the whole proposed half, at the end of the paragraph.
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 12, 18),
      ),
    );
    suggestingCut(editor);

    expect(editor.state.doc.textContent).toBe("Hello world");
    expect(markKinds(editor)).toEqual(["delete"]);

    const onDiagnostic = vi.fn();
    const output = editorStateToReviewMarkdown(editor.getJSON(), new Map(), {
      onDiagnostic,
    });

    expect(output).toContain('Hello <del id="rd-s1">world</del>');
    expect(output).toContain("  rd-s1:");
    expect(onDiagnostic).not.toHaveBeenCalled();

    editor.destroy();
  });
});

describe("word delete across a hard break", () => {
  /**
   * A hard break contributes no characters to `textBetween` but does occupy a
   * position, so arithmetic that subtracts a character count from a document
   * position runs past the word it matched and takes the break with it.
   */
  it.each([
    {
      name: "backward from the end of the word after the break",
      caret: 8,
      direction: "backward" as const,
      expected: { from: 5, to: 8 },
    },
    {
      name: "forward from the start of the word before the break",
      caret: 1,
      direction: "forward" as const,
      expected: { from: 1, to: 4 },
    },
  ])(
    "selects the word and not the break, $name",
    ({ caret, direction, expected }) => {
      const editor = createTestEditor("<p>foo<br>bar</p>");

      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, caret),
        ),
      );

      expect(resolveRemovalRange(editor.view.state, direction, "word")).toEqual(
        expected,
      );

      editor.destroy();
    },
  );
});

describe("a node selection holding no inline content", () => {
  /**
   * Review markup is inline, so a thematic break selected as a node offers
   * nothing an anchor can wrap. Replacing it would take original content out of
   * the document with no record that it ever stood there, so the input is
   * refused and the document is left as it is.
   */
  it("leaves a horizontal rule standing rather than replacing it", () => {
    const editor = createTestEditor("<p>Before</p><hr><p>After</p>");
    const rulePosition = editor.state.doc.child(0).nodeSize;
    const selection = NodeSelection.create(editor.state.doc, rulePosition);

    // A click on a thematic break selects it exactly this way.
    expect(selection.node.type.name).toBe("horizontalRule");
    editor.view.dispatch(editor.state.tr.setSelection(selection));

    suggestingTypeWithSelection(editor, "X");

    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).type.name).toBe("horizontalRule");
    expect(editor.state.doc.textContent).toBe("BeforeAfter");
    expect(getMarks(editor)).toHaveLength(0);

    editor.destroy();
  });
});

describe("Type-with-selection should delete inserted text, not mark it replace-old", () => {
  it("should delete inserted text and insert a new suggestion when typing over one", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Type " new" after "Hello"
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select " new" (the inserted text at positions 6-10)
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 6, 10),
      ),
    );

    // Type " replaced" over the selection
    suggestingTypeWithSelection(editor, " replaced");

    expect(markKinds(editor)).not.toContain("replace-old");
    expect(editor.state.doc.textContent).toContain("replaced");

    editor.destroy();
  });
});

/**
 * The menu's Suggest deletion action proposes the same edit as pressing
 * Backspace over a selection, so it runs the same code and inherits the rule
 * that consecutive removals stay one suggestion. Stamping a fresh mark over the
 * selection instead would overwrite whatever suggestion it covers.
 */
describe("the menu's Suggest deletion action over an existing suggestion", () => {
  const EXISTING_DELETION =
    '<p>alpha <del id="rd-s1">bravo charlie</del> delta</p>';

  it("extends the existing deletion when the selection overlaps its end", () => {
    const editor = createTestEditor(EXISTING_DELETION);

    selectText(editor, "charlie delta");
    suggestMenuDeletion(editor);

    expect(getMarks(editor)).toEqual([
      { text: "bravo charlie delta", kind: "delete" },
    ]);
    expect(suggestionIdsOfKind(editor, "delete")).toEqual(["rd-s1"]);

    editor.destroy();
  });

  it("keeps the existing deletion's id when the selection contains it", () => {
    const editor = createTestEditor(
      '<p>alpha <del id="rd-s1">bravo</del> charlie</p>',
    );

    selectText(editor, "alpha bravo charlie");
    suggestMenuDeletion(editor);

    expect(getMarks(editor)).toEqual([
      { text: "alpha bravo charlie", kind: "delete" },
    ]);
    expect(suggestionIdsOfKind(editor, "delete")).toEqual(["rd-s1"]);

    editor.destroy();
  });

  it("mints a separate id for a deletion that abuts no other", () => {
    const editor = createTestEditor(EXISTING_DELETION);

    selectText(editor, "delta");
    suggestMenuDeletion(editor);

    // `alpha ` still stands between the two, so this is a second suggestion
    // rather than a continuation of the first.
    expect(getMarks(editor)).toEqual([
      { text: "bravo charlie", kind: "delete" },
      { text: "delta", kind: "delete" },
    ]);

    const [first, second] = suggestionIdsOfKind(editor, "delete");
    expect(first).toBe("rd-s1");
    expect(second).not.toBe(first);

    editor.destroy();
  });
});
