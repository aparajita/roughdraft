import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { fixtureMarkdown, readFixtures } from "../test/spec-fixtures.js";
import {
  collectOrphanedRecords,
  parseDocument,
  type RfmDocument,
  serializeDocument,
} from "./document.js";
import {
  type CommentId,
  parseCommentId,
  parseSuggestionId,
  type RecordId,
  RecordIdAllocator,
  type SuggestionId,
} from "./ids.js";
import {
  anchorCrossesBlockCode,
  appendRoughdraftDocumentComment,
  appendRoughdraftReply,
  endmatterReplyCycleCode,
  extractRoughdraftReviewIndex,
  markRoughdraftResolved,
  validateRoughdraftMarkdown,
} from "./index.js";

const at = "2026-04-28T12:00:00.000Z";

function commentId(value: string): CommentId {
  const id = parseCommentId(value);
  if (!id) throw new Error(`Not a comment id: ${value}`);
  return id;
}

function suggestionId(value: string): SuggestionId {
  const id = parseSuggestionId(value);
  if (!id) throw new Error(`Not a suggestion id: ${value}`);
  return id;
}

function roundTrip(markdown: string): string {
  return serializeDocument(parseDocument(markdown));
}

function anchorIds(document: RfmDocument): string[] {
  return document.anchors.map((anchor) => anchor.id);
}

function diagnosticCodes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

/**
 * A body carrying an anchored comment, a two-deep reply chain beneath it, a
 * document-scope comment, and a suggestion — the four ways a record can earn
 * its place, in one document, so the retention rule and the write contract are
 * asked about the same records.
 */
function withRecords(body: string): string {
  return [
    body,
    "",
    "---",
    'roughdraft: "1.0"',
    "comments:",
    "  rd-c1:",
    "    body: Anchored comment.",
    "    by: user",
    `    at: "${at}"`,
    "  rd-c2:",
    "    body: Reply to the anchored comment.",
    "    by: AI",
    `    at: "${at}"`,
    "    re: rd-c1",
    "  rd-c3:",
    "    body: Reply to the reply.",
    "    by: user",
    `    at: "${at}"`,
    "    re: rd-c2",
    "  rd-c4:",
    "    body: Comment on the whole document.",
    "    by: user",
    `    at: "${at}"`,
    "    scope: document",
    "suggestions:",
    "  rd-s1:",
    "    by: AI",
    `    at: "${at}"`,
    "",
  ].join("\n");
}

describe("extractRoughdraftReviewIndex", () => {
  const fixtures = readFixtures();

  it("finds the specification fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  // A fixture states the values an entry carries; the schema also defines
  // optional properties a fixture may leave out, so entries are matched on
  // what the fixture states. The array forms still require the same number of
  // entries in the same order.
  it.each(fixtures)("reproduces the review index of $name", ({ fixture }) => {
    const index = extractRoughdraftReviewIndex(fixture.source.markdown);

    expect(index.comments).toMatchObject(fixture.comments);
    expect(index.suggestions).toMatchObject(fixture.suggestions);
  });
});

describe("id allocation", () => {
  const anchoredOnly = [
    'Ship <span id="rd-c3">guest checkout</span> and',
    '<ins id="rd-s2">one example</ins>.',
    "",
    "---",
    'roughdraft: "1.0"',
    "comments:",
    "  rd-c3:",
    "    body: Confirm this.",
    "    by: user",
    `    at: "${at}"`,
    "suggestions:",
    "  rd-s2:",
    "    by: AI",
    `    at: "${at}"`,
    "",
  ].join("\n");

  const endmatterAhead = [
    'Ship <span id="rd-c1">guest checkout</span>.',
    "",
    "---",
    'roughdraft: "1.0"',
    "comments:",
    "  rd-c1:",
    "    body: Confirm this.",
    "    by: user",
    `    at: "${at}"`,
    "  rd-c7:",
    "    body: Agreed.",
    "    by: AI",
    `    at: "${at}"`,
    "    re: rd-c1",
    "",
  ].join("\n");

  const documentScopeOnly = [
    "Ship guest checkout.",
    "",
    "---",
    'roughdraft: "1.0"',
    "comments:",
    "  rd-c5:",
    "    body: Read the whole thing.",
    "    by: user",
    `    at: "${at}"`,
    "    scope: document",
    "",
  ].join("\n");

  it.each([
    {
      name: "anchors and records agree",
      markdown: anchoredOnly,
      comment: "rd-c4",
      suggestion: "rd-s3",
    },
    {
      name: "a reply in the endmatter is above every anchor",
      markdown: endmatterAhead,
      comment: "rd-c8",
      suggestion: "rd-s1",
    },
    {
      name: "a document-scope comment has no anchor at all",
      markdown: documentScopeOnly,
      comment: "rd-c6",
      suggestion: "rd-s1",
    },
  ])("takes the highest number when $name", ({
    markdown,
    comment,
    suggestion,
  }) => {
    const ids = new RecordIdAllocator(parseDocument(markdown));

    expect(ids.allocateCommentId()).toBe(comment);
    expect(ids.allocateSuggestionId()).toBe(suggestion);
  });

  it("advances without the document changing", () => {
    const ids = new RecordIdAllocator(parseDocument(anchoredOnly));

    expect([
      ids.allocateCommentId(),
      ids.allocateCommentId(),
      ids.allocateCommentId(),
    ]).toEqual(["rd-c4", "rd-c5", "rd-c6"]);
    expect([ids.allocateSuggestionId(), ids.allocateSuggestionId()]).toEqual([
      "rd-s3",
      "rd-s4",
    ]);
  });

  it("does not reissue an id after the record carrying it is gone", () => {
    const ids = new RecordIdAllocator(parseDocument(anchoredOnly));
    const allocated = ids.allocateCommentId();

    // The document the editor would write next holds neither the id just
    // allocated nor the one it was allocated above.
    ids.reserve(parseDocument("Ship guest checkout.\n"));

    expect(ids.allocateCommentId()).not.toBe(allocated);
    expect(ids.allocateCommentId()).toBe("rd-c6");
  });

  it("reserves ids a document introduces above the mark", () => {
    const ids = new RecordIdAllocator(parseDocument(documentScopeOnly));

    ids.reserve(parseDocument(endmatterAhead));

    expect(ids.allocateCommentId()).toBe("rd-c8");
  });
});

describe("collectOrphanedRecords", () => {
  it.each([
    {
      name: "the anchors are present",
      body: 'Ship <span id="rd-c1">guest checkout</span> with <ins id="rd-s1">care</ins>.',
      comments: ["rd-c1", "rd-c2", "rd-c3", "rd-c4"],
      suggestions: ["rd-s1"],
      dropped: [],
    },
    {
      name: "the anchors are gone",
      body: "Ship guest checkout.",
      comments: ["rd-c4"],
      suggestions: [],
      dropped: ["rd-c1", "rd-c2", "rd-c3", "rd-s1"],
    },
  ])("keeps the document comment and the anchored reply chain when $name", ({
    body,
    comments,
    suggestions,
    dropped,
  }) => {
    const collected = collectOrphanedRecords(parseDocument(withRecords(body)));

    expect([...collected.document.comments.keys()]).toEqual(comments);
    expect([...collected.document.suggestions.keys()]).toEqual(suggestions);
    expect(collected.dropped).toEqual(dropped);
  });
});

describe("parse and serialize", () => {
  it("leaves a trailing YAML block without a roughdraft key in the body", () => {
    const markdown = [
      "Ship guest checkout in the beta.",
      "",
      "---",
      "title: Release notes",
      "tags:",
      "  - beta",
      "",
    ].join("\n");

    const document = parseDocument(markdown);

    expect(document.comments.size).toBe(0);
    expect(document.suggestions.size).toBe(0);
    expect(document.body).toContain("title: Release notes");
    expect(serializeDocument(document)).toBe(markdown);
  });

  it("preserves unrecognized endmatter keys at both levels", () => {
    const markdown = [
      'Ship <span id="rd-c1">guest checkout</span>.',
      "",
      "---",
      'roughdraft: "1.0"',
      "reviewRound: 2",
      "comments:",
      "  rd-c1:",
      "    body: Confirm this.",
      "    by: user",
      `    at: "${at}"`,
      "    thread: onboarding",
      "",
    ].join("\n");

    const written = parseDocument(roundTrip(markdown));
    const comment = written.comments.get(commentId("rd-c1"));

    expect(written.extraEndmatterKeys).toEqual({ reviewRound: 2 });
    expect(comment?.metadata).toEqual({ thread: "onboarding" });
  });

  it("preserves an anchor's non-id attributes", () => {
    const markdown = [
      'Ship <span id="rd-c1" class="note" data-origin="import">guest checkout</span>.',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Confirm this.",
      "    by: user",
      `    at: "${at}"`,
      "",
    ].join("\n");

    const serialized = roundTrip(markdown);

    expect(serialized).toContain(
      '<span id="rd-c1" class="note" data-origin="import">guest checkout</span>',
    );
    expect(parseDocument(serialized).anchors).toHaveLength(1);
  });

  it("writes back every record it was given, anchored or not", () => {
    // rd-c1 is anchored, rd-s1 is not, and nothing asked for orphans to be
    // collected — so a write that drops rd-s1 loses a reviewer's suggestion.
    const markdown = withRecords(
      'Ship <span id="rd-c1">guest checkout</span>.',
    );
    const written = parseDocument(roundTrip(markdown));

    expect([...written.comments.keys()]).toEqual([
      "rd-c1",
      "rd-c2",
      "rd-c3",
      "rd-c4",
    ]);
    expect([...written.suggestions.keys()]).toEqual(["rd-s1"]);
  });

  it("reads, writes and re-reads a record whose body is empty", () => {
    const markdown = [
      'Ship <span id="rd-c1">guest checkout</span>.',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      '    body: ""',
      "    by: user",
      `    at: "${at}"`,
      "",
    ].join("\n");

    const written = roundTrip(markdown);

    expect(validateRoughdraftMarkdown(markdown).diagnostics).toEqual([]);
    expect(validateRoughdraftMarkdown(written).diagnostics).toEqual([]);
    expect(parseDocument(written).comments.get(commentId("rd-c1"))?.body).toBe(
      "",
    );
  });

  it("writes `at` and `resolved` as strings a YAML 1.1 reader keeps as strings", () => {
    const resolvedAt = "2026-05-01T09:00:00.000Z";
    const markdown = markRoughdraftResolved(
      withRecords('Ship <span id="rd-c1">guest checkout</span>.'),
      { targetId: "rd-c1", summary: resolvedAt },
    );
    const block = parseDocument(markdown).endmatterBlock;
    if (block === null)
      throw new Error("The written document has no endmatter");

    const endmatter = parseYaml(block.replace(/^\n---[ \t]*\r?\n/, ""), {
      version: "1.1",
    }) as { comments: Record<string, { at: unknown; resolved: unknown }> };
    const record = endmatter.comments["rd-c1"];

    expect([typeof record?.at, typeof record?.resolved]).toEqual([
      "string",
      "string",
    ]);
    expect(record).toMatchObject({ at, resolved: resolvedAt });
  });

  it("reads an anchor containing a self-closing tag of the same name", () => {
    const markdown =
      'Ship <span id="rd-c1">guest <span class="badge"/>checkout</span>.\n';

    const document = parseDocument(markdown);

    expect(document.anchors).toMatchObject([{ id: "rd-c1", kind: "span" }]);
    expect(document.diagnostics).toEqual([]);
  });

  it("reports an anchor whose ends lie in different blocks", () => {
    const markdown = fixtureMarkdown("cross-block-anchor.json");

    expect(
      diagnosticCodes(validateRoughdraftMarkdown(markdown).errors),
    ).toEqual([anchorCrossesBlockCode]);
    // The anchor is still read, so the record it binds keeps its anchor rather
    // than being orphaned by a defect the file arrived with.
    expect(anchorIds(parseDocument(markdown))).toEqual(["rd-c1"]);
  });
});

describe("reply cycles", () => {
  /**
   * The ids from `start` up to the record that replies to nothing, refusing to
   * walk further than the document has records. A chain still holding a cycle
   * never reaches a root, so the walk would not terminate at all.
   */
  function ancestryOf(document: RfmDocument, start: CommentId): CommentId[] {
    const chain: CommentId[] = [];
    let current: CommentId | undefined = start;

    while (current !== undefined) {
      if (chain.length > document.comments.size) {
        throw new Error(`Reply chain from ${start} does not terminate.`);
      }

      chain.push(current);
      const re: RecordId | undefined = document.comments.get(current)?.re;
      current =
        re === undefined ? undefined : (parseCommentId(re) ?? undefined);
    }

    return chain;
  }

  it("drops the reply link that closes a mutual cycle and reports it", () => {
    const markdown = [
      'Ship <span id="rd-c1">guest checkout</span>.',
      "",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Confirm this.",
      "    by: user",
      `    at: "${at}"`,
      "    re: rd-c2",
      "  rd-c2:",
      "    body: Confirmed.",
      "    by: AI",
      `    at: "${at}"`,
      "    re: rd-c1",
      "",
    ].join("\n");

    const document = parseDocument(markdown);

    expect(diagnosticCodes(document.diagnostics)).toEqual([
      endmatterReplyCycleCode,
    ]);
    expect(
      [...document.comments.keys()].map((id) => ancestryOf(document, id)),
    ).toEqual([["rd-c1", "rd-c2"], ["rd-c2"]]);
  });
});

describe("writing to a record nothing anchors", () => {
  const unanchored = [
    "Ship guest checkout.",
    "",
    "---",
    'roughdraft: "1.0"',
    "comments:",
    "  rd-c1:",
    "    body: Confirm this.",
    "    by: user",
    `    at: "${at}"`,
    "",
  ].join("\n");

  it.each([
    {
      name: "appendRoughdraftReply",
      write: () =>
        appendRoughdraftReply(unanchored, {
          parentId: "rd-c1",
          message: "Agreed.",
        }),
    },
    {
      name: "markRoughdraftResolved",
      write: () => markRoughdraftResolved(unanchored, { targetId: "rd-c1" }),
    },
  ])("$name throws and produces no document", ({ write }) => {
    expect(write).toThrow(/no anchor/);

    // Nothing was written, so the record is exactly as it was: no reply beside
    // it, and no resolution on it.
    const document = parseDocument(unanchored);
    expect([...document.comments.keys()]).toEqual(["rd-c1"]);
    expect(document.comments.get(commentId("rd-c1"))?.status).toBeUndefined();
  });

  it("refuses a requested comment id a body anchor already carries", () => {
    // The endmatter holds no rd-c1, but the anchor does: binding a new record
    // to that id would bind it to an unrelated span.
    const markdown = 'Ship <span id="rd-c1">guest checkout</span>.\n';

    expect(() =>
      appendRoughdraftDocumentComment(markdown, {
        message: "Read the whole thing.",
        id: "rd-c1",
      }),
    ).toThrow(/already in use/);
  });
});

describe("code regions", () => {
  const markdown = [
    'Use `<span id="rd-c1">guest checkout</span>` inline, and:',
    "",
    "```html",
    '<ins id="rd-s1">one concrete example</ins>',
    "```",
    "",
  ].join("\n");

  it("reads no anchor inside a fenced block or an inline code span", () => {
    expect(parseDocument(markdown).anchors).toEqual([]);
  });

  it("leaves the code regions as literal text", () => {
    const serialized = roundTrip(markdown);

    expect(serialized).toContain('`<span id="rd-c1">guest checkout</span>`');
    expect(serialized).toContain('<ins id="rd-s1">one concrete example</ins>');
    expect(
      parseDocument(serialized).suggestions.get(suggestionId("rd-s1")),
    ).toBeUndefined();
  });

  it("does not read an inline code span across a blank line", () => {
    // Were the two stray backticks read as one span, the anchor between them
    // would be literal text and the comment would lose its anchor.
    const strayBackticks = [
      "The ` character opens a code span.",
      "",
      'It closes on the <span id="rd-c1">same</span> line, never ` later.',
      "",
    ].join("\n");

    expect(anchorIds(parseDocument(strayBackticks))).toEqual(["rd-c1"]);
  });

  it("keeps the records of a body whose anchors sit between prose backticks", () => {
    const written = parseDocument(
      roundTrip(fixtureMarkdown("stray-backticks.json")),
    );

    expect(anchorIds(written)).toEqual(["rd-c1"]);
    expect([...written.comments.keys()]).toEqual(["rd-c1"]);
    expect(written.diagnostics).toEqual([]);
  });

  const documentShowingEndmatter = [
    "# Guide",
    "",
    "Endmatter looks like this:",
    "",
    "````markdown",
    "---",
    'roughdraft: "1.0"',
    "comments:",
    "  rd-c1:",
    "    body: Example",
    "    by: AI",
    `    at: "${at}"`,
    "````",
    "",
    "That block is an example, not this document's own endmatter.",
    "",
  ].join("\n");

  it("reads no endmatter from a delimiter inside a fenced block", () => {
    const document = parseDocument(documentShowingEndmatter);

    expect(document.endmatterVersion).toBeNull();
    expect(document.comments.size).toBe(0);
  });

  it("keeps everything after a fenced endmatter example in the body", () => {
    expect(roundTrip(documentShowingEndmatter)).toBe(documentShowingEndmatter);
  });

  it("reads no endmatter from a document that ends inside an unclosed fence", () => {
    const unclosed = [
      "# Guide",
      "",
      "Endmatter looks like this:",
      "",
      "```markdown",
      "---",
      'roughdraft: "1.0"',
      "comments:",
      "  rd-c1:",
      "    body: Example",
      "    by: AI",
      `    at: "${at}"`,
      "",
    ].join("\n");

    const document = parseDocument(unclosed);

    expect(document.endmatterVersion).toBeNull();
    expect(document.comments.size).toBe(0);
    expect(document.body).toBe(unclosed);
    expect(serializeDocument(document)).toBe(unclosed);
  });
});
