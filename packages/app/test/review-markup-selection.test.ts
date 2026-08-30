import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createEditorExtensions } from "../src/editor-extensions";
import {
  getReviewMarkupBlockedReason,
  type ReviewMarkupSubject,
} from "../src/review-markup-selection";

/**
 * `ab` and `gh` sit outside a four-character code span, which is the smallest
 * document holding every way a selection can meet one: inside it, across either
 * edge, exactly over it, and clear of it.
 */
const INLINE_CODE_DOCUMENT = "<p>ab<code>cdef</code>gh</p>";

const CODE_BLOCK_DOCUMENT = "<pre><code>const answer = 42</code></pre>";

function withEditor<T>(content: string, use: (editor: Editor) => T): T {
  const editor = new Editor({
    extensions: createEditorExtensions(""),
    content,
  });

  try {
    return use(editor);
  } finally {
    editor.destroy();
  }
}

/** The `[from, to)` positions of `text`, as `setTextSelection` expects them. */
function selectionOf(editor: Editor, text: string) {
  const documentText = editor.state.doc.textBetween(
    0,
    editor.state.doc.content.size,
    "\n",
  );
  const start = documentText.indexOf(text);

  if (start < 0) throw new Error(`Editor does not contain ${text}`);

  return { from: start + 1, to: start + text.length + 1 };
}

function reasonForSelectedText(
  content: string,
  text: string,
  subject: ReviewMarkupSubject = "comment",
) {
  return withEditor(content, (editor) => {
    editor.commands.setTextSelection(selectionOf(editor, text));

    return getReviewMarkupBlockedReason(editor, subject);
  });
}

function reasonForCursor(
  content: string,
  position: number,
  subject: ReviewMarkupSubject = "comment",
) {
  return withEditor(content, (editor) => {
    editor.commands.setTextSelection(position);

    return getReviewMarkupBlockedReason(editor, subject);
  });
}

describe("a selection meeting inline code", () => {
  it.each([
    { name: "lying inside the code span", text: "de" },
    { name: "crossing the code span's start", text: "bc" },
    { name: "crossing the code span's end", text: "fg" },
  ])("refuses one $name", ({ text }) => {
    expect(reasonForSelectedText(INLINE_CODE_DOCUMENT, text)).toContain(
      "cannot start or end inside inline code",
    );
  });

  it.each([
    { name: "covering the code span exactly", text: "cdef" },
    { name: "containing the code span and the text around it", text: "bcdefg" },
    { name: "ending where the code span starts", text: "ab" },
    { name: "starting where the code span ends", text: "gh" },
  ])("allows one $name", ({ text }) => {
    expect(reasonForSelectedText(INLINE_CODE_DOCUMENT, text)).toBeNull();
  });

  // "Suggest insertion" acts on a cursor rather than a range, so where the
  // cursor sits decides whether the insertion would split the code span.
  it.each([
    { name: "one character into the code span", position: 4 },
    { name: "one character before its end", position: 6 },
  ])("refuses a cursor $name", ({ position }) => {
    expect(reasonForCursor(INLINE_CODE_DOCUMENT, position)).toContain(
      "cannot start or end inside inline code",
    );
  });

  it.each([
    { name: "at the code span's start", position: 3 },
    { name: "at the code span's end", position: 7 },
  ])("allows a cursor $name", ({ position }) => {
    expect(reasonForCursor(INLINE_CODE_DOCUMENT, position)).toBeNull();
  });
});

describe("a selection inside a code block", () => {
  it("refuses a range within the block", () => {
    expect(reasonForSelectedText(CODE_BLOCK_DOCUMENT, "answer")).toContain(
      "cannot be placed inside a code block",
    );
  });

  it("refuses a cursor within the block", () => {
    expect(reasonForCursor(CODE_BLOCK_DOCUMENT, 3)).toContain(
      "cannot be placed inside a code block",
    );
  });
});

describe("the refused subject", () => {
  it("names what the reviewer asked to place", () => {
    expect(
      reasonForSelectedText(INLINE_CODE_DOCUMENT, "de", "comment"),
    ).toMatch(/^A comment /);
    expect(
      reasonForSelectedText(INLINE_CODE_DOCUMENT, "de", "suggestion"),
    ).toMatch(/^A suggestion /);
  });
});

describe("a selection meeting an existing comment anchor", () => {
  /**
   * `<p>abcd</p>` with a comment anchored to `ab`, the smallest document in
   * which a second comment can partially overlap the first.
   */
  const ANCHORED_DOCUMENT = '<p><span id="rd-c1">ab</span>cd</p>';

  it.each([
    { name: "covering the anchor exactly", text: "ab", refused: false },
    { name: "lying inside the anchor", text: "a", refused: false },
    { name: "containing the anchor", text: "abc", refused: false },
    { name: "crossing the anchor's end", text: "bc", refused: true },
    { name: "clear of the anchor", text: "cd", refused: false },
  ])("refuses one $name: $refused", ({ text, refused }) => {
    const reason = reasonForSelectedText(ANCHORED_DOCUMENT, text);

    expect(reason === null).toBe(!refused);

    if (refused) {
      expect(reason).toContain(
        "cannot start or end inside an existing comment",
      );
    }
  });

  it("allows a cursor inside the anchor", () => {
    expect(reasonForCursor(ANCHORED_DOCUMENT, 2)).toBeNull();
  });

  /**
   * A mark inside an anchor splits the anchor across two text nodes. Both carry
   * the same anchor, so a selection crossing the split stays inside one comment
   * and has an anchor that can hold it.
   */
  it("reads text nodes carrying one anchor as a single range", () => {
    const content = '<p><span id="rd-c1">ab<strong>cd</strong></span>ef</p>';

    expect(reasonForSelectedText(content, "bc")).toBeNull();
  });
});

describe("a selection crossing a block boundary", () => {
  it("is refused", () => {
    const content = "<p>first block</p><p>second block</p>";

    expect(reasonForSelectedText(content, "block\nsecond")).toContain(
      "cannot span more than one block",
    );
  });
});
