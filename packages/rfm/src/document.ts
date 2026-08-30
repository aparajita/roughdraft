import { type Anchor, scanAnchors } from "./anchors.js";
import {
  type CommentRecord,
  type EndmatterRecords,
  parseEndmatter,
  renderEndmatter,
  type SuggestionRecord,
} from "./endmatter.js";
import {
  type CommentId,
  parseCommentId,
  parseSuggestionId,
  type RecordId,
  type SuggestionId,
} from "./ids.js";
import { createLiteralSpanIndex } from "./literal-spans.js";
import type { RfmDiagnostic } from "./scanner.js";

/**
 * The document: frontmatter, body, anchors and records, read and written as
 * one unit.
 *
 * Every caller in every package reads through {@link parseDocument} and writes
 * through {@link serializeDocument}, so the contract of the pair is stated
 * here rather than rediscovered at each call site.
 */

export interface YamlFrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

/**
 * A parsed document.
 *
 * `frontmatter` is the leading YAML block as written, delimiters and trailing
 * blank lines included, or null when the document has none.
 *
 * `body` is the Markdown between the frontmatter and the endmatter. It is the
 * text `anchors` and `diagnostics` are measured against: every offset, line
 * and column in this structure is relative to the text following the
 * frontmatter, so an offset within an endmatter diagnostic points past the end
 * of `body`.
 *
 * `comments` and `suggestions` hold the endmatter records in the order they
 * were written. `extraEndmatterKeys` holds the top-level endmatter keys this
 * specification does not define; they are given back on write.
 *
 * `diagnostics` describe problems in the document as it was read — a
 * malformed anchor, a record missing `by`. They never describe a defect in the
 * caller, and parsing never throws: a document that cannot be read as a review
 * layer parses as one with no records.
 */
export interface RfmDocument {
  frontmatter: string | null;
  body: string;
  anchors: Anchor[];
  comments: Map<CommentId, CommentRecord>;
  suggestions: Map<SuggestionId, SuggestionRecord>;
  extraEndmatterKeys: Record<string, unknown>;
  /**
   * The `roughdraft` key's value as written, or null when the document carries
   * no endmatter. A document with an endmatter block and no records still
   * reports a version, so a caller deciding whether a document is already 1.0
   * asks this rather than inspecting the record maps.
   */
  endmatterVersion: string | null;
  /**
   * The endmatter block as written — its `---` delimiter included, beginning
   * with the newline that precedes the delimiter — or null when the document
   * carries no endmatter.
   *
   * It is the block's text, not a rendering of the records: a caller that must
   * hand back what it read, keys this specification does not define included,
   * carries this rather than reconstructing the block.
   */
  endmatterBlock: string | null;
  diagnostics: RfmDiagnostic[];
}

/**
 * Read `markdown` as a Roughdraft Flavored Markdown document.
 *
 * Preserved: the frontmatter as written, the body exactly as written including
 * every anchor element and all of its attributes, the endmatter's records and
 * its unrecognized keys, and a trailing YAML block that is not endmatter —
 * that block has no `roughdraft` key, so it is document content and stays in
 * `body`.
 *
 * Dropped: nothing. A record is dropped only by {@link collectOrphanedRecords},
 * which a caller invokes deliberately, so neither reading nor writing a
 * document can cost it a record.
 *
 * The literal-span index is built once, from the text following the
 * frontmatter, and both readers query it. Two indexes are two chances for the
 * endmatter reader and the anchor reader to disagree about where code begins.
 */
export function parseDocument(markdown: string): RfmDocument {
  const { frontmatter, body: content } = splitYamlFrontmatter(markdown);
  const literalSpans = createLiteralSpanIndex(content);
  const endmatter = parseEndmatter(content, literalSpans);
  const body =
    endmatter.offset === null ? content : content.slice(0, endmatter.offset);
  const { anchors, diagnostics: anchorDiagnostics } = scanAnchors(
    body,
    literalSpans,
  );

  const diagnostics = [...anchorDiagnostics, ...endmatter.diagnostics].sort(
    (left, right) => left.offset - right.offset,
  );

  return {
    frontmatter,
    body,
    anchors,
    comments: endmatter.comments,
    suggestions: endmatter.suggestions,
    extraEndmatterKeys: endmatter.extraKeys,
    endmatterVersion: endmatter.version,
    endmatterBlock: endmatter.raw,
    diagnostics,
  };
}

/**
 * Write `document` back to Markdown.
 *
 * Requires a document whose records are the records it should carry — a
 * document straight from {@link parseDocument}, or one a caller has edited,
 * with {@link collectOrphanedRecords} already applied when the caller wanted
 * orphans collected.
 *
 * Writes the frontmatter and body as they stand, every comment and suggestion
 * the document holds, and every unrecognized endmatter key, with `roughdraft`
 * as the first key of the block. A document with nothing to record — no record
 * and no unrecognized key — is written with no endmatter block at all.
 *
 * Drops nothing. A record the body no longer anchors is written back like any
 * other: this function has no opinion about which records a document should
 * hold, and a writer that never asked to collect orphans must not lose one by
 * saving.
 *
 * Promises nothing about byte-for-byte round-tripping of the endmatter block:
 * the records are re-rendered, so key order within a record and YAML style
 * follow {@link renderEndmatter}, not the block as it was read. The body,
 * including every anchor, is unchanged.
 *
 * `document.diagnostics` are not consulted: a document that read with
 * diagnostics still writes, because refusing to write is how a hand-edited
 * file loses the review layer it does have.
 */
export function serializeDocument(document: RfmDocument): string {
  const block = renderEndmatter({
    comments: document.comments,
    suggestions: document.suggestions,
    extraKeys: document.extraEndmatterKeys,
  });
  const content = block
    ? `${document.body.replace(/\s*$/, "\n")}\n${block}`
    : document.body;

  return prependYamlFrontmatter(content, document.frontmatter);
}

/** A document with its orphaned records removed, and the ids removed. */
export interface OrphanCollection {
  document: RfmDocument;
  dropped: RecordId[];
}

/**
 * Remove from `document` the records the body no longer justifies keeping.
 *
 * A record is kept when an anchor carrying its id is in the body, when it
 * carries `scope: document`, or when its `re` names a kept record. The last
 * rule resolves transitively, so dropping a record drops its replies, their
 * replies, and so on. A record whose `re` names a record that is not present
 * is a top-level comment and is kept only on its own merits.
 *
 * Requires a document whose `anchors` describe its `body`. A caller that has
 * edited the body re-parses it before calling; the retention rule is a
 * question about the body as it stands, and stale anchors answer it about a
 * body that no longer exists.
 *
 * This is how a record is deleted. There is no other way: neither
 * {@link parseDocument} nor {@link serializeDocument} drops a record, so a
 * writer that does not call this cannot lose one, and a writer that does call
 * it has said so.
 *
 * `document` is not modified — the returned document is a new structure
 * sharing the original's body, anchors and unrecognized keys. `dropped` is
 * every removed record's id, in the order the document held them, and is what
 * a caller shows a human: the reviewer whose comment the edit orphaned learns
 * it from this list.
 */
export function collectOrphanedRecords(
  document: RfmDocument,
): OrphanCollection {
  const retained = retainRecords(document);
  const dropped: RecordId[] = [];

  for (const id of document.comments.keys()) {
    if (!retained.comments.has(id)) dropped.push(id);
  }

  for (const id of document.suggestions.keys()) {
    if (!retained.suggestions.has(id)) dropped.push(id);
  }

  return {
    document: {
      ...document,
      comments: retained.comments,
      suggestions: retained.suggestions,
    },
    dropped,
  };
}

/**
 * The records of `document` the retention rule keeps.
 *
 * The rule itself, applied by {@link collectOrphanedRecords} to remove records
 * and by the cross-reference diagnostics to warn about them. Applying it is
 * not deleting: this function reports, and the caller decides what that means.
 *
 * A record is retained when an anchor with its id is in the body, when it has
 * `scope: document`, or when its `re` names a retained record. The last rule
 * is resolved transitively, so dropping a record drops its replies, their
 * replies, and so on. A record whose `re` names a record that is not present
 * is a top-level comment and is retained only on its own merits.
 */
export function retainRecords(document: RfmDocument): EndmatterRecords {
  const anchoredComments = new Set<string>();
  const anchoredSuggestions = new Set<string>();

  for (const anchor of document.anchors) {
    if (parseCommentId(anchor.id)) anchoredComments.add(anchor.id);
    if (parseSuggestionId(anchor.id)) anchoredSuggestions.add(anchor.id);
  }

  const retained = new Set<string>();

  for (const [id] of document.suggestions) {
    if (anchoredSuggestions.has(id)) retained.add(id);
  }

  for (const [id, record] of document.comments) {
    if (anchoredComments.has(id) || record.scope === "document") {
      retained.add(id);
    }
  }

  let grew = true;
  while (grew) {
    grew = false;

    for (const [id, record] of document.comments) {
      if (retained.has(id)) continue;
      if (!record.re || !retained.has(record.re)) continue;

      retained.add(id);
      grew = true;
    }
  }

  return {
    comments: filterMap(document.comments, retained),
    suggestions: filterMap(document.suggestions, retained),
    extraKeys: document.extraEndmatterKeys,
  };
}

function filterMap<Key extends string, Value>(
  records: ReadonlyMap<Key, Value>,
  retained: ReadonlySet<string>,
): Map<Key, Value> {
  const kept = new Map<Key, Value>();

  for (const [id, record] of records) {
    if (retained.has(id)) kept.set(id, record);
  }

  return kept;
}

/** The leading YAML frontmatter block of `markdown`, and the text after it. */
export function splitYamlFrontmatter(markdown: string): YamlFrontmatterSplit {
  const openingDelimiter = markdown.match(/^---[ \t]*(?:\r\n|\n)/);
  if (!openingDelimiter) return { frontmatter: null, body: markdown };

  let lineStart = openingDelimiter[0].length;

  while (lineStart < markdown.length) {
    const nextLineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = nextLineBreak === -1 ? markdown.length : nextLineBreak + 1;
    const line = markdown.slice(
      lineStart,
      nextLineBreak === -1 ? lineEnd : lineEnd - 1,
    );

    if (isYamlFrontmatterDelimiter(line)) {
      let bodyStart = lineEnd;

      while (bodyStart < markdown.length) {
        const blankLineBreak = markdown.indexOf("\n", bodyStart);
        const blankLineEnd =
          blankLineBreak === -1 ? markdown.length : blankLineBreak + 1;
        const blankLine = markdown.slice(
          bodyStart,
          blankLineBreak === -1 ? blankLineEnd : blankLineEnd - 1,
        );

        if (blankLine.replace(/\r$/, "").trim() !== "") break;
        bodyStart = blankLineEnd;
      }

      return {
        frontmatter: markdown.slice(0, bodyStart),
        body: markdown.slice(bodyStart),
      };
    }

    lineStart = lineEnd;
  }

  return { frontmatter: null, body: markdown };
}

export function prependYamlFrontmatter(
  markdown: string,
  frontmatter?: string | null,
): string {
  return frontmatter ? `${frontmatter}${markdown}` : markdown;
}

export function appendYamlEndmatter(
  markdown: string,
  endmatter?: string | null,
): string {
  return endmatter
    ? `${markdown.replace(/\s*$/, "\n")}\n${endmatter}`
    : markdown;
}

function isYamlFrontmatterDelimiter(line: string): boolean {
  return /^(?:---|\.\.\.)[ \t]*$/.test(line.replace(/\r$/, ""));
}
