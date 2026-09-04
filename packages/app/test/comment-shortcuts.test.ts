import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  getAddCommentShortcutLabel,
  matchesAddCommentShortcut,
} from "../src/comment-shortcuts";
import { createEditorExtensions } from "../src/editor-extensions";
import { getReviewMarkupBlockedReason } from "../src/review-markup-selection";

const MAC_ADD_COMMENT_EVENT = {
  code: "Enter",
  key: "Enter",
  altKey: false,
  ctrlKey: false,
  metaKey: true,
  shiftKey: false,
};

/**
 * An editor holding `<p>abcd</p>` with a comment anchored to `ab`, which is
 * the smallest document in which a second comment can partially overlap the
 * first.
 */
function createAnchoredEditor(): Editor {
  return new Editor({
    extensions: createEditorExtensions(""),
    content: '<p><span id="rd-c1">ab</span>cd</p>',
  });
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

/** Every `commentAnchor` range in the document, as text and ids. */
function commentAnchorRanges(editor: Editor) {
  const ranges: Array<{ text: string; commentIds: string[] }> = [];

  editor.state.doc.descendants((node) => {
    if (!node.isText) return;

    for (const mark of node.marks) {
      if (mark.type.name !== "commentAnchor") continue;

      ranges.push({
        text: node.text ?? "",
        commentIds: [...(mark.attrs.commentIds as string[])],
      });
    }
  });

  return ranges;
}

describe("comment shortcuts", () => {
  it("formats the add comment shortcut label for Mac platforms", () => {
    expect(getAddCommentShortcutLabel("MacIntel")).toBe("Cmd + Return");
    expect(getAddCommentShortcutLabel("iPhone")).toBe("Cmd + Return");
  });

  it("formats the add comment shortcut label for non-Mac platforms", () => {
    expect(getAddCommentShortcutLabel("Win32")).toBe("Ctrl + Enter");
    expect(getAddCommentShortcutLabel("Linux x86_64")).toBe("Ctrl + Enter");
  });

  it("matches the Mac add comment shortcut", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "Enter",
          key: "Enter",
          altKey: false,
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
  });

  it("matches the Windows add comment shortcut", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "Enter",
          key: "Enter",
          altKey: false,
          ctrlKey: true,
          metaKey: false,
          shiftKey: false,
        },
        "Win32",
      ),
    ).toBe(true);
  });

  it("rejects Enter with no modifier held", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "Enter",
          key: "Enter",
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        },
        "Win32",
      ),
    ).toBe(false);
  });

  it("rejects Enter with both Ctrl and Cmd held on Mac", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "Enter",
          key: "Enter",
          altKey: false,
          ctrlKey: true,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("rejects Enter with Shift held", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "Enter",
          key: "Enter",
          altKey: false,
          ctrlKey: false,
          metaKey: true,
          shiftKey: true,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("rejects Enter with Alt held", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "Enter",
          key: "Enter",
          altKey: true,
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("rejects a non-Enter code even with the right modifier", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "NumpadEnter",
          key: "Enter",
          altKey: false,
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });
});

describe("the add comment shortcut's selection guard", () => {
  it("leaves both anchors untouched when the keyboard path refuses a selection", () => {
    const editor = createAnchoredEditor();

    try {
      expect(matchesAddCommentShortcut(MAC_ADD_COMMENT_EVENT, "MacIntel")).toBe(
        true,
      );

      editor.commands.setTextSelection(selectionOf(editor, "bc"));

      // The shortcut handler runs the same guard before touching the document.
      if (!getReviewMarkupBlockedReason(editor, "comment")) {
        editor.commands.setCommentAnchor({ commentIds: ["rd-c2"] });
      }

      expect(commentAnchorRanges(editor)).toEqual([
        { text: "ab", commentIds: ["rd-c1"] },
      ]);
    } finally {
      editor.destroy();
    }
  });
});
