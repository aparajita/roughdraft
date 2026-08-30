import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  getAddCommentShortcutLabel,
  matchesAddCommentShortcut,
} from "../src/comment-shortcuts";
import { createEditorExtensions } from "../src/editor-extensions";
import { getReviewMarkupBlockedReason } from "../src/review-markup-selection";

const MAC_ADD_COMMENT_EVENT = {
  code: "KeyM",
  key: "m",
  altKey: true,
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
    expect(getAddCommentShortcutLabel("MacIntel")).toBe("Cmd + Option + M");
    expect(getAddCommentShortcutLabel("iPhone")).toBe("Cmd + Option + M");
  });

  it("formats the add comment shortcut label for non-Mac platforms", () => {
    expect(getAddCommentShortcutLabel("Win32")).toBe("Ctrl + Alt + M");
    expect(getAddCommentShortcutLabel("Linux x86_64")).toBe("Ctrl + Alt + M");
  });

  it("matches the Mac add comment shortcut", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "m",
          altKey: true,
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
          code: "KeyM",
          key: "M",
          altKey: true,
          ctrlKey: true,
          metaKey: false,
          shiftKey: false,
        },
        "Win32",
      ),
    ).toBe(true);
  });

  it("rejects partial or conflicting modifier combinations", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "m",
          altKey: false,
          ctrlKey: true,
          metaKey: false,
          shiftKey: false,
        },
        "Win32",
      ),
    ).toBe(false);

    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "m",
          altKey: true,
          ctrlKey: true,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("matches the Mac shortcut from the physical key code even when Option changes the character", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyM",
          key: "µ",
          altKey: true,
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
  });

  it("rejects non-M physical keys even if the produced character is m", () => {
    expect(
      matchesAddCommentShortcut(
        {
          code: "KeyN",
          key: "m",
          altKey: true,
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
