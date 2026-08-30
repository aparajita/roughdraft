import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { createEditorExtensions } from "../src/editor-extensions";
import { createTurndownService, EMPTY_ANCHOR_SENTINEL } from "../src/markdown";
import {
  editorStateToReviewMarkdown,
  getCommentDescendantIds,
  type ReviewComment,
  reviewMarkdownHasReviewRail,
  reviewMarkdownToEditorState,
  reviewMarkdownToRenderedHtml,
} from "../src/review";
import { readMarkdownFixture } from "./fixtures";

/** Read a document into editor state and write it straight back out. */
function roundTrip(markdown: string): string {
  const { doc, comments, frontmatter, endmatter } =
    reviewMarkdownToEditorState(markdown);

  return editorStateToReviewMarkdown(doc, comments, { frontmatter, endmatter });
}

function withEditor<T>(doc: JSONContent, use: (editor: Editor) => T): T {
  const editor = new Editor({
    extensions: createEditorExtensions(""),
    content: doc,
  });

  try {
    return use(editor);
  } finally {
    editor.destroy();
  }
}

/**
 * The `[from, to)` positions of `text` in the editor, in the coordinates
 * `setTextSelection` expects.
 */
function selectionOf(
  editor: Editor,
  text: string,
): { from: number; to: number } {
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
function commentAnchorRanges(
  editor: Editor,
): Array<{ text: string; commentIds: string[] }> {
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

const ANCHORED_COMMENT = [
  'Ship <span id="rd-c1">guest checkout</span> in the beta.',
  "",
  "---",
  'roughdraft: "1.0"',
  "comments:",
  "  rd-c1:",
  "    body: Confirm this excludes SSO-only workspaces.",
  "    by: AI",
  '    at: "2026-08-28T12:00:00.000Z"',
  "",
].join("\n");

describe("review documents", () => {
  it("preserves YAML frontmatter delimiters and raw table-like YAML text", () => {
    const input = [
      "---",
      "title: Frontmatter round trip",
      "summary: |",
      "  | column | value |",
      "  | --- | --- |",
      "  | path | docs/table.md |",
      "tags:",
      "  - roughdraft",
      "---",
      "",
      "# Body",
      "Opening this file in rich text should not rewrite frontmatter.",
      "",
    ].join("\n");

    expect(roundTrip(input)).toBe(input);
  });

  it.each([
    {
      name: "an anchored comment",
      markdown: ANCHORED_COMMENT,
      hasReviewRail: true,
    },
    {
      name: "a document-scope comment with no anchor",
      markdown: [
        "# Draft",
        "",
        "---",
        'roughdraft: "1.0"',
        "comments:",
        "  rd-c1:",
        "    body: Please address the risk section.",
        "    by: user",
        '    at: "2026-08-28T12:00:00.000Z"',
        "    scope: document",
        "",
      ].join("\n"),
      hasReviewRail: true,
    },
    {
      name: "anchor markup inside a fenced code block",
      markdown: [
        "```md",
        'This is <ins id="rd-s1">inserted</ins> text.',
        "```",
        "",
      ].join("\n"),
      hasReviewRail: false,
    },
    {
      name: "a trailing YAML block with no roughdraft key",
      markdown: [
        "# Release notes",
        "",
        "---",
        "comments:",
        "  rd-c1:",
        "    by: docs",
        '    at: "not review metadata"',
        "",
      ].join("\n"),
      hasReviewRail: false,
    },
  ])("detects a review rail for $name", ({ markdown, hasReviewRail }) => {
    expect(reviewMarkdownHasReviewRail(markdown)).toBe(hasReviewRail);
  });

  it("reads an anchored comment and writes it back unchanged", () => {
    const { comments } = reviewMarkdownToEditorState(ANCHORED_COMMENT);

    expect(comments.get("rd-c1")).toMatchObject({
      id: "rd-c1",
      content: "Confirm this excludes SSO-only workspaces.",
      authorType: "ai",
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    expect(roundTrip(ANCHORED_COMMENT)).toBe(ANCHORED_COMMENT);
  });

  it("reads a reply chain and writes it back unchanged", () => {
    const input = [
      'Ship <span id="rd-c1">guest checkout</span> in the beta.',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Confirm this excludes SSO-only workspaces.",
      "    by: user",
      '    at: "2026-08-28T12:00:00.000Z"',
      "  rd-c2:",
      "    body: Confirmed. SSO-only workspaces are out of the beta.",
      "    by: AI",
      '    at: "2026-08-28T12:05:00.000Z"',
      "    re: rd-c1",
      "  rd-c3:",
      "    body: Noted in the launch checklist.",
      "    by: user",
      '    at: "2026-08-28T12:07:00.000Z"',
      "    re: rd-c2",
      "",
    ].join("\n");

    const { comments } = reviewMarkdownToEditorState(input);

    expect(comments.get("rd-c2")).toMatchObject({
      id: "rd-c2",
      parentCommentId: "rd-c1",
      authorType: "ai",
    });
    expect(getCommentDescendantIds("rd-c1", comments)).toEqual([
      "rd-c2",
      "rd-c3",
    ]);
    expect(roundTrip(input)).toBe(input);
  });

  it("drops a reply when its parent comment is deleted", () => {
    const input = [
      'Ship <span id="rd-c1">guest checkout</span> in the beta.',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Confirm this excludes SSO-only workspaces.",
      "    by: user",
      '    at: "2026-08-28T12:00:00.000Z"',
      "  rd-c2:",
      "    body: I can soften this.",
      "    by: AI",
      '    at: "2026-08-28T12:05:00.000Z"',
      "    re: rd-c1",
      "",
    ].join("\n");

    const { doc, comments, endmatter } = reviewMarkdownToEditorState(input);
    const remaining = new Map(comments);
    remaining.delete("rd-c2");

    const output = editorStateToReviewMarkdown(doc, remaining, { endmatter });

    expect(output).toContain("rd-c1:");
    expect(output).not.toContain("rd-c2:");
    expect(output).not.toContain("I can soften this.");
  });

  it("preserves endmatter keys this module has no field for", () => {
    const input = [
      'Ship <span id="rd-c1">guest checkout</span> in the beta.',
      "",
      "---",
      'roughdraft: "1.0"',
      "workflow:",
      "  owner: editorial",
      "comments:",
      "  rd-c1:",
      "    body: Confirm this excludes SSO-only workspaces.",
      "    by: user",
      '    at: "2026-08-28T12:00:00.000Z"',
      "    status: resolved",
      "    resolved: Scoped to non-SSO workspaces.",
      "",
    ].join("\n");

    const output = roundTrip(input);

    expect(output).toContain("workflow:");
    expect(output).toContain("owner: editorial");
    expect(output).toContain("status: resolved");
    expect(output).toContain('resolved: "Scoped to non-SSO workspaces."');
  });

  it("keeps a trailing YAML block that is not endmatter as document content", () => {
    const input = [
      "# Markdown examples",
      "",
      "A normal horizontal rule follows.",
      "",
      "---",
      "",
      "```yaml",
      "comments:",
      "  rd-c1:",
      "    body: This is documentation, not review metadata.",
      "```",
      "",
    ].join("\n");

    const { comments, endmatter } = reviewMarkdownToEditorState(input);
    const output = roundTrip(input);

    expect(endmatter).toBeNull();
    expect(comments.size).toBe(0);
    expect(output).toContain("```yaml");
    expect(output).toContain("This is documentation, not review metadata.");
  });

  it("renders a document-scope comment without inventing an anchor", () => {
    const input = [
      "# Draft",
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Please address the risk section.",
      "    by: user",
      '    at: "2026-08-28T12:00:00.000Z"',
      "    scope: document",
      "",
    ].join("\n");

    const { comments, html } = reviewMarkdownToRenderedHtml(input);

    expect(comments.get("rd-c1")).toMatchObject({
      id: "rd-c1",
      content: "Please address the risk section.",
      authorType: "user",
      parentCommentId: null,
      scope: "document",
    });
    expect(html).not.toContain("rd-c1");
    expect(roundTrip(input)).toBe(input);
  });
});

describe("anchor serialization", () => {
  it.each([
    {
      name: "an insertion anchor stays HTML",
      html: '<p>Add <ins id="rd-s1">new text</ins> here.</p>',
      markdown: 'Add <ins id="rd-s1">new text</ins> here.\n',
    },
    {
      name: "a deletion anchor stays HTML",
      html: '<p>Remove <del id="rd-s2">old text</del> here.</p>',
      markdown: 'Remove <del id="rd-s2">old text</del> here.\n',
    },
    {
      name: "a comment anchor stays HTML",
      html: '<p>Ship <span id="rd-c1">guest checkout</span>.</p>',
      markdown: 'Ship <span id="rd-c1">guest checkout</span>.\n',
    },
    {
      name: "an anchor keeps attributes besides id",
      html: '<p>Ship <span id="rd-c1" data-source="import">guest checkout</span>.</p>',
      markdown:
        'Ship <span id="rd-c1" data-source="import">guest checkout</span>.\n',
    },
    {
      name: "a plain del with no anchor id becomes strikethrough",
      html: "<p>Keep <del>removed</del> text.</p>",
      markdown: "Keep ~~removed~~ text.\n",
    },
  ])("$name", ({ html, markdown }) => {
    const service = createTurndownService();

    expect(`${service.turndown(html).trimEnd()}\n`).toBe(markdown);
  });
});

describe("editor state to review markdown", () => {
  it("writes a point anchor as an empty span with the sentinel stripped", () => {
    const input = [
      'Ship guest checkout.<span id="rd-c1"></span>',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Consider whether this belongs in the summary.",
      "    by: user",
      '    at: "2026-08-28T12:00:00.000Z"',
      "",
    ].join("\n");

    const { doc, comments } = reviewMarkdownToEditorState(input);

    expect(comments.get("rd-c1")?.content).toBe(
      "Consider whether this belongs in the summary.",
    );
    expect(JSON.stringify(doc)).toContain(EMPTY_ANCHOR_SENTINEL);
    expect(roundTrip(input)).toBe(input);
  });

  it("writes two paired editor marks as one span-wrapped replacement", () => {
    const input = [
      'Use <span id="rd-s1"><del>rough</del><ins>specific</ins></span> wording.',
      "",
      "---",
      'roughdraft: "1.0"',
      "suggestions:",
      "  rd-s1:",
      "    by: AI",
      '    at: "2026-08-28T12:00:00.000Z"',
      "",
    ].join("\n");

    const { doc } = reviewMarkdownToEditorState(input);
    const kinds = withEditor(doc, (editor) => {
      const found: string[] = [];

      editor.state.doc.descendants((node) => {
        if (!node.isText) return;

        for (const mark of node.marks) {
          if (mark.type.name === "suggestion") {
            found.push(mark.attrs.kind as string);
          }
        }
      });

      return found;
    });

    expect(kinds).toEqual(["replace-old", "replace-new"]);
    expect(roundTrip(input)).toBe(input);
  });

  it("reports a replacement half whose partner is missing instead of writing half of it", () => {
    const onDiagnostic = vi.fn();
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            {
              type: "text",
              text: "rough",
              marks: [
                {
                  type: "suggestion",
                  attrs: {
                    kind: "replace-old",
                    suggestionId: "rd-s1",
                    createdAt: "2026-08-28T12:00:00.000Z",
                    authorType: "user",
                    authorId: "user",
                  },
                },
              ],
            },
            { type: "text", text: " wording." },
          ],
        },
      ],
    };

    const output = editorStateToReviewMarkdown(doc, new Map(), {
      onDiagnostic,
    });

    expect(output).toBe("Use rough wording.\n");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "review-unpaired-replacement",
        suggestionId: "rd-s1",
      }),
    );
  });

  it("writes two comments nested over one range as nested spans", () => {
    const input = [
      'Ship <span id="rd-c1"><span id="rd-c2">guest checkout</span></span> in the beta.',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Confirm this excludes SSO-only workspaces.",
      "    by: user",
      '    at: "2026-08-28T12:00:00.000Z"',
      "  rd-c2:",
      "    body: Name the beta cohort here.",
      "    by: AI",
      '    at: "2026-08-28T12:05:00.000Z"',
      "",
    ].join("\n");

    const { doc } = reviewMarkdownToEditorState(input);

    expect(withEditor(doc, commentAnchorRanges)).toEqual([
      { text: "guest checkout", commentIds: ["rd-c1", "rd-c2"] },
    ]);
    expect(roundTrip(input)).toBe(input);
  });

  /**
   * The mark carries the anchor's non-`id` attributes, so rebuilding it from
   * the remaining ids alone silently rewrites the anchor the file was written
   * with. The check is on the written document rather than the mark, because
   * the attributes exist only to survive the write.
   */
  it("keeps an anchor's other attributes when one of its comment ids is removed", () => {
    const input = [
      'Ship <span id="rd-c1" data-source="import"><span id="rd-c2">guest checkout</span></span> in the beta.',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Confirm this excludes SSO-only workspaces.",
      "    by: user",
      '    at: "2026-08-28T12:00:00.000Z"',
      "  rd-c2:",
      "    body: Name the beta cohort here.",
      "    by: AI",
      '    at: "2026-08-28T12:05:00.000Z"',
      "",
    ].join("\n");
    const { doc, comments, endmatter } = reviewMarkdownToEditorState(input);
    const remaining = new Map(comments);
    remaining.delete("rd-c2");

    const output = withEditor(doc, (editor) => {
      editor.commands.removeCommentId("rd-c2");

      return editorStateToReviewMarkdown(editor.getJSON(), remaining, {
        endmatter,
      });
    });

    expect(output).toContain(
      '<span id="rd-c1" data-source="import">guest checkout</span>',
    );
  });

  it("keeps the anchor attached when nearby text changes", () => {
    const input = [
      'Before <span id="rd-c1">target</span> after.',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Check this.",
      "    by: AI",
      '    at: "2026-08-28T12:00:00.000Z"',
      "",
    ].join("\n");
    const { doc, comments, endmatter } = reviewMarkdownToEditorState(input);
    const edited = structuredClone(doc);
    const firstTextNode = edited.content?.[0]?.content?.[0];

    if (firstTextNode?.type !== "text") {
      throw new Error("Expected leading text node in parsed paragraph");
    }

    firstTextNode.text = "Before nearby ";

    expect(editorStateToReviewMarkdown(edited, comments, { endmatter })).toBe(
      input.replace("Before <span", "Before nearby <span"),
    );
  });

  it("round-trips anchors inside headings and list items", () => {
    const input = [
      '## Use <ins id="rd-s1">new title</ins>',
      "",
      '- Keep <del id="rd-s2">old item</del>',
      '- <span id="rd-c1">Second item</span>',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Needs review.",
      "    by: AI",
      '    at: "2026-08-28T12:00:00.000Z"',
      "suggestions:",
      "  rd-s1:",
      "    by: AI",
      '    at: "2026-08-28T12:01:00.000Z"',
      "  rd-s2:",
      "    by: user",
      '    at: "2026-08-28T12:02:00.000Z"',
      "",
    ].join("\n");

    expect(roundTrip(input)).toBe(input);
  });

  it("creates one comment anchor when a selection spans inline code", () => {
    const input =
      "Each dev wrapper keeps its own server state under `~/.roughdraft/dev/<wrapper-name>` by default, so opening works.\n";
    const { doc } = reviewMarkdownToEditorState(input);
    const comment: ReviewComment = {
      id: "rd-c1",
      content: "test",
      createdAt: "2026-08-28T12:00:00.000Z",
      authorType: "user",
      authorId: "user",
    };

    const output = withEditor(doc, (editor) => {
      editor.commands.setTextSelection(
        selectionOf(
          editor,
          "its own server state under ~/.roughdraft/dev/<wrapper-name> by default",
        ),
      );
      editor.commands.setCommentAnchor({ commentIds: ["rd-c1"] });

      return editorStateToReviewMarkdown(
        editor.getJSON(),
        new Map([["rd-c1", comment]]),
      );
    });

    expect(output).toContain(
      '<span id="rd-c1">its own server state under `~/.roughdraft/dev/<wrapper-name>` by default</span>',
    );
    expect(output).toContain("body: test");
  });
});

describe("suggestion review actions", () => {
  it.each([
    {
      name: "an insertion",
      body: 'Add <ins id="rd-s1">new text</ins> here.',
      accepted: "Add new text here.\n",
      rejected: "Add here.\n",
    },
    {
      name: "a deletion",
      body: 'Remove <del id="rd-s1">old text</del> here.',
      accepted: "Remove here.\n",
      rejected: "Remove old text here.\n",
    },
    {
      name: "a replacement",
      body: 'Use <span id="rd-s1"><del>rough</del><ins>specific</ins></span> here.',
      accepted: "Use specific here.\n",
      rejected: "Use rough here.\n",
    },
  ])("accepts and rejects $name", ({ body, accepted, rejected }) => {
    const input = [
      body,
      "",
      "---",
      'roughdraft: "1.0"',
      "suggestions:",
      "  rd-s1:",
      "    by: user",
      '    at: "2026-08-28T12:00:00.000Z"',
      "",
    ].join("\n");
    const parsed = reviewMarkdownToEditorState(input);

    const write = (apply: (editor: Editor) => void) =>
      withEditor(structuredClone(parsed.doc), (editor) => {
        apply(editor);

        return editorStateToReviewMarkdown(editor.getJSON(), parsed.comments, {
          endmatter: parsed.endmatter,
        });
      });

    expect(write((editor) => editor.commands.acceptSuggestion("rd-s1"))).toBe(
      accepted,
    );
    expect(write((editor) => editor.commands.rejectSuggestion("rd-s1"))).toBe(
      rejected,
    );
  });
});

describe("markdown fixtures", () => {
  it.each([
    "all-anchor-forms.md",
    "anchors-basic.md",
    "anchors-code-fences.md",
    "frontmatter-table-yaml.md",
    "mixed-roundtrip.md",
  ])("round-trips %s", (fixtureName) => {
    expect(roundTrip(readMarkdownFixture(fixtureName))).toBe(
      readMarkdownFixture(fixtureName),
    );
  });

  it("keeps anchor markup in code spans and fenced code literal and record-free", () => {
    const input = readMarkdownFixture("anchors-code-fences.md");
    const { comments } = reviewMarkdownToEditorState(input);

    expect(comments.size).toBe(0);
    expect(reviewMarkdownHasReviewRail(input)).toBe(false);
    expect(roundTrip(input)).toBe(input);
  });
});

describe("Markdown rich-text round-trip regressions", () => {
  it.each([
    {
      name: "GFM strikethrough markup",
      markdown: "Keep ~~removed~~ and **bold** text.\n",
    },
    {
      name: "inline link titles",
      markdown: '[Roughdraft](./README.md "Local title")\n',
    },
    {
      name: "image titles",
      markdown: '![Alt text](./image.png "Image title")\n',
    },
    {
      name: "mailto autolinks",
      markdown: "Visit <https://example.com/a?b=c> or <me@example.com>.\n",
    },
    {
      name: "source-only HTML comments",
      markdown: [
        "Before",
        "",
        "<!-- keep this source note -->",
        "",
        "After",
        "",
      ].join("\n"),
    },
    {
      name: "raw details HTML blocks",
      markdown: [
        "<details>",
        "<summary>More</summary>",
        "",
        "Hidden **markdown** body.",
        "",
        "</details>",
        "",
      ].join("\n"),
    },
    {
      name: "multi-line indented code blocks after lists",
      markdown: [
        "- Item before",
        "",
        "    code block",
        "    second line",
        "",
        "After",
        "",
      ].join("\n"),
    },
    {
      name: "table cells containing escaped pipes and inline code pipes",
      markdown: [
        "| Column | Value |",
        "| --- | --- |",
        "| Escaped | `a | b` and plain a \\| b |",
        "",
      ].join("\n"),
    },
    {
      name: "fenced code blocks with no trailing blank line",
      markdown: [
        "```text",
        "Use Roughdraft to open, review, and compare markdown files.",
        "",
        "Start it with `roughdraft start` if needed.",
        "```",
        "",
      ].join("\n"),
    },
  ])("preserves $name", ({ markdown }) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });
});
