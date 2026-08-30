import { describe, expect, it } from "vitest";
import { parseDocument } from "./document.js";
import { type CommentId, parseCommentId } from "./ids.js";
import { migrateAnchorTruncatedCode, migrateCriticMarkup } from "./migrate.js";

const at = "2026-04-28T12:00:00.000Z";

function commentId(value: string): CommentId {
  const id = parseCommentId(value);
  if (!id) throw new Error(`Not a comment id: ${value}`);
  return id;
}

describe("migrateCriticMarkup", () => {
  it.each([
    {
      name: "an anchored comment",
      source: "Please revisit {==this sentence==}{>>Needs a source.<<}.\n",
      anchor: '<span id="rd-c1">this sentence</span>',
      comments: 1,
      suggestions: 0,
    },
    {
      name: "a comment with nothing highlighted",
      source: "Please revisit this sentence.{>>Needs a source.<<}\n",
      anchor: '<span id="rd-c1"></span>',
      comments: 1,
      suggestions: 0,
    },
    {
      name: "an insertion",
      source: "Add {++one concrete example++}.\n",
      anchor: '<ins id="rd-s1">one concrete example</ins>',
      comments: 0,
      suggestions: 1,
    },
    {
      name: "a deletion",
      source: "Drop {--this clause--}.\n",
      anchor: '<del id="rd-s1">this clause</del>',
      comments: 0,
      suggestions: 1,
    },
    {
      name: "a replacement",
      source: "Use {~~rough~>specific~~} wording.\n",
      anchor: '<span id="rd-s1"><del>rough</del><ins>specific</ins></span>',
      comments: 0,
      suggestions: 1,
    },
  ])("converts $name", ({ source, anchor, comments, suggestions }) => {
    const result = migrateCriticMarkup(source);
    const document = parseDocument(result.markdown);

    expect(result.markdown).toContain(anchor);
    expect(result.converted).toBe(comments + suggestions);
    expect(document.comments.size).toBe(comments);
    expect(document.suggestions.size).toBe(suggestions);
    expect(document.diagnostics).toEqual([]);
  });

  it("maps existing ids and remaps a reply that names one", () => {
    const source = [
      "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.",
      "",
      `Add {++one concrete example++}{id="s1" by="AI" at="${at}"}.`,
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      `    at: "${at}"`,
      "  c2:",
      "    body: Agreed, the launch story works.",
      "    by: AI",
      `    at: "${at}"`,
      "    re: c1",
      "suggestions:",
      "  s1:",
      "    by: AI",
      `    at: "${at}"`,
      "",
    ].join("\n");

    const result = migrateCriticMarkup(source);
    const document = parseDocument(result.markdown);

    expect(result.markdown).toContain('<span id="rd-c1">this sentence</span>');
    expect(result.markdown).toContain(
      '<ins id="rd-s1">one concrete example</ins>',
    );
    expect([...document.comments.keys()]).toEqual(["rd-c1", "rd-c2"]);
    expect(document.comments.get(commentId("rd-c1"))).toMatchObject({
      body: "Needs a source.",
      by: "user",
      at,
    });
    expect(document.comments.get(commentId("rd-c2"))?.re).toBe("rd-c1");
    expect(result.converted).toBe(3);
  });

  it("does not allocate an id already mapped from an existing one", () => {
    const source = [
      "First {==alpha==}{>>Unnamed comment.<<}.",
      "",
      "Second {==beta==}{>>Named comment.<<}{#c1}.",
      "",
    ].join("\n");

    const result = migrateCriticMarkup(source);
    const document = parseDocument(result.markdown);

    expect(result.markdown).toContain('<span id="rd-c1">beta</span>');
    expect(result.markdown).toContain('<span id="rd-c2">alpha</span>');
    expect(document.comments.get(commentId("rd-c1"))?.body).toBe(
      "Named comment.",
    );
    expect(document.comments.get(commentId("rd-c2"))?.body).toBe(
      "Unnamed comment.",
    );
  });

  it.each([
    {
      name: "CriticMarkup inside code regions",
      source: [
        "Write `{++text++}` to suggest an insertion, as in:",
        "",
        "```markdown",
        "Please revisit {==this sentence==}{>>Needs a source.<<}",
        "```",
        "",
      ].join("\n"),
    },
    {
      // A `comments` key alone does not make a block endmatter. Reading this
      // one as a record set would move the document's own prose into the
      // review layer and take the block out of the body.
      name: "a trailing YAML block whose comments key holds no records",
      source: [
        "Endmatter entries look like this:",
        "",
        "---",
        "title: Sample endmatter",
        "comments:",
        "  foo:",
        "    body: sample",
        "",
      ].join("\n"),
    },
  ])("leaves $name alone", ({ source }) => {
    const result = migrateCriticMarkup(source);
    const document = parseDocument(result.markdown);

    expect(result.markdown).toBe(source);
    expect(result.converted).toBe(0);
    expect(document.anchors).toEqual([]);
    expect(document.comments.size).toBe(0);
  });

  it("anchors a cross-block highlight to the first block and reports it", () => {
    const source = [
      "Please revisit {==this sentence",
      "",
      "and this one==}{>>Needs a source.<<}.",
      "",
    ].join("\n");

    const result = migrateCriticMarkup(source);
    const document = parseDocument(result.markdown);

    expect(result.markdown).toContain('<span id="rd-c1">this sentence</span>');
    // No text moves or is duplicated: the rest of the highlight stays in the
    // body as ordinary Markdown, outside any anchor.
    expect(result.markdown).toContain("\nand this one.\n");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      migrateAnchorTruncatedCode,
    ]);
    expect(document.diagnostics).toEqual([]);
    expect(document.comments.get(commentId("rd-c1"))?.body).toBe(
      "Needs a source.",
    );
  });
});
