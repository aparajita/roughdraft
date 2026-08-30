import {
  parseDocument,
  type RfmDocument,
  retainRecords,
  serializeDocument,
} from "./document.js";
import {
  type CommentRecord,
  RFM_VERSION,
  type SuggestionRecord,
} from "./endmatter.js";
import {
  type CommentId,
  parseCommentId,
  parseSuggestionId,
  RecordIdAllocator,
  type SuggestionId,
} from "./ids.js";
import { type RfmDiagnostic, shiftDiagnostics } from "./scanner.js";

export {
  type Anchor,
  type AnchorAttributes,
  anchorCrossesBlockCode,
  anchorDuplicateIdCode,
  anchorMalformedReplacementCode,
  anchorPartialOverlapCode,
  anchorUnclosedCode,
  type CommentAnchor,
  type ScanAnchorsResult,
  type SuggestionAnchor,
  scanAnchors,
} from "./anchors.js";
export {
  appendYamlEndmatter,
  collectOrphanedRecords,
  type OrphanCollection,
  parseDocument,
  prependYamlFrontmatter,
  type RfmDocument,
  retainRecords,
  serializeDocument,
  splitYamlFrontmatter,
  type YamlFrontmatterSplit,
} from "./document.js";
export {
  type CommentRecord,
  type EndmatterRecords,
  endmatterReplyCycleCode,
  findFinalYamlEndmatter,
  isEndmatterBlock,
  isYamlMappingBlock,
  type ParsedEndmatter,
  parseEndmatter,
  RFM_VERSION,
  renderEndmatter,
  type SuggestionRecord,
} from "./endmatter.js";
export {
  type CommentId,
  parseCommentId,
  parseRecordId,
  parseSuggestionId,
  type RecordId,
  RecordIdAllocator,
  type SuggestionId,
} from "./ids.js";
export {
  createLiteralSpanIndex,
  type LiteralSpanIndex,
} from "./literal-spans.js";
export {
  buildReviewIndex,
  type CommentAnchorKind,
  type CommentIndexAnchor,
  type CommentIndexEntry,
  extractRoughdraftReviewIndex,
  type RfmReviewIndex,
  type RfmReviewIndexSummary,
  type SuggestionIndexEntry,
  type SuggestionKind,
  summarizeReviewIndex,
} from "./review-index.js";
export {
  createLineStarts,
  isLineStart,
  locationForOffset,
  nextLineOffset,
  type RfmDiagnostic,
  type RfmDiagnosticSeverity,
  skipHtmlWhitespace,
  skipSpaces,
  type TextLocation,
} from "./scanner.js";

export interface RfmValidationSummary {
  comments: number;
  suggestions: number;
}

export interface RfmValidationResult {
  format: "roughdraft-flavored-markdown";
  version: typeof RFM_VERSION;
  ok: boolean;
  diagnostics: RfmDiagnostic[];
  errors: RfmDiagnostic[];
  warnings: RfmDiagnostic[];
  summary: RfmValidationSummary;
}

export interface AppendRoughdraftReplyOptions {
  parentId: string;
  message: string;
  author?: string;
  at?: string;
  id?: string;
}

export interface AppendRoughdraftDocumentCommentOptions {
  message: string;
  author?: string;
  at?: string;
  id?: string;
}

export interface MarkRoughdraftResolvedOptions {
  targetId: string;
  summary?: string;
}

export const missingRecordCode = "rfm-missing-record";
export const orphanRecordCode = "rfm-orphan-record";
export const missingReplyTargetCode = "rfm-missing-reply-target";

const defaultDocumentCommentAuthor = "user";
const defaultReplyAuthor = "AI";

/**
 * Read `markdown` and report what is wrong with its review layer.
 *
 * Diagnostics are located against the whole file, frontmatter included.
 */
export function validateRoughdraftMarkdown(
  markdown: string,
): RfmValidationResult {
  const document = parseDocument(markdown);
  const frontmatter = document.frontmatter ?? "";
  const diagnostics = shiftDiagnostics(
    [...document.diagnostics, ...crossReferenceDiagnostics(document)].sort(
      (left, right) => left.offset - right.offset,
    ),
    frontmatter.length,
    countLines(frontmatter),
  );

  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  const warnings = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  );

  return {
    format: "roughdraft-flavored-markdown",
    version: RFM_VERSION,
    ok: errors.length === 0,
    diagnostics,
    errors,
    warnings,
    summary: {
      comments: document.comments.size,
      suggestions: document.suggestions.size,
    },
  };
}

/**
 * The problems only visible with the body and the endmatter side by side: an
 * anchor with no record, a record that no write would keep, and a reply whose
 * parent is gone.
 */
function crossReferenceDiagnostics(document: RfmDocument): RfmDiagnostic[] {
  const diagnostics: RfmDiagnostic[] = [];
  const anchoredIds = new Set<string>();
  const endmatterOffset = document.body.length;

  for (const anchor of document.anchors) {
    anchoredIds.add(anchor.id);

    const commentId = parseCommentId(anchor.id);
    const suggestionId = parseSuggestionId(anchor.id);
    const hasRecord = commentId
      ? document.comments.has(commentId)
      : suggestionId !== null && document.suggestions.has(suggestionId);
    if (hasRecord) continue;

    diagnostics.push({
      severity: "error",
      code: missingRecordCode,
      message: `Anchor \`${anchor.id}\` has no endmatter record.`,
      offset: anchor.offset,
      line: anchor.line,
      column: anchor.column,
    });
  }

  const recordIds = new Set<string>([
    ...document.comments.keys(),
    ...document.suggestions.keys(),
  ]);

  const addEndmatterDiagnostic = (
    severity: "error" | "warning",
    code: string,
    message: string,
  ) => {
    diagnostics.push({
      severity,
      code,
      message,
      offset: endmatterOffset,
      line: countLines(document.body) + 1,
      column: 1,
    });
  };

  // Whether a record survives a write is decided in one place, so the warning
  // asks the writer rather than restating its rules.
  const retained = retainRecords(document);

  for (const [id, record] of document.comments) {
    if (record.re && !recordIds.has(record.re)) {
      addEndmatterDiagnostic(
        "warning",
        missingReplyTargetCode,
        `Comment \`${id}\` replies to \`${record.re}\`, which is not in this document.`,
      );
    }

    if (retained.comments.has(id)) continue;

    addEndmatterDiagnostic(
      "warning",
      orphanRecordCode,
      `Comment \`${id}\` has no anchor and is not a document comment, so a write drops it.`,
    );
  }

  for (const [id] of document.suggestions) {
    if (retained.suggestions.has(id)) continue;

    addEndmatterDiagnostic(
      "warning",
      orphanRecordCode,
      `Suggestion \`${id}\` has no anchor, so a write drops it.`,
    );
  }

  return diagnostics;
}

function countLines(text: string): number {
  let lines = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lines += 1;
  }

  return lines;
}

/**
 * Add a comment about the document as a whole.
 *
 * The comment has no anchor, so it carries `scope: document`, which is what
 * keeps it through later writes.
 */
export function appendRoughdraftDocumentComment(
  markdown: string,
  options: AppendRoughdraftDocumentCommentOptions,
): string {
  const document = parseDocument(markdown);
  const id = commentIdFor(options.id, document);

  document.comments.set(id, {
    body: options.message,
    by: options.author ?? defaultDocumentCommentAuthor,
    at: options.at ?? new Date().toISOString(),
    scope: "document",
    metadata: {},
  });

  return serializeDocument(document);
}

/**
 * Reply to a comment or a suggestion.
 *
 * Throws when `options.parentId` names no record in the document, and throws a
 * distinct error when it names a record the endmatter holds but nothing in the
 * body anchors and that carries no `scope: document` — such a record cannot be
 * replied to, because a reply is kept only for as long as its parent is, and
 * nothing keeps that parent. Also throws when `options.id` is not a comment id
 * or is already spoken for anywhere in the document.
 */
export function appendRoughdraftReply(
  markdown: string,
  options: AppendRoughdraftReplyOptions,
): string {
  const document = parseDocument(markdown);
  const parent = requireRecord(document, options.parentId);
  const id = commentIdFor(options.id, document);

  document.comments.set(id, {
    body: options.message,
    by: options.author ?? defaultReplyAuthor,
    at: options.at ?? new Date().toISOString(),
    re: parent.id,
    metadata: {},
  });

  return serializeDocument(document);
}

/**
 * Mark a comment or a suggestion resolved.
 *
 * Throws when `options.targetId` names no record in the document, and throws a
 * distinct error when it names a record the endmatter holds but nothing in the
 * body anchors and that carries no `scope: document` — resolving such a record
 * would report success about a record no reader can reach.
 */
export function markRoughdraftResolved(
  markdown: string,
  options: MarkRoughdraftResolvedOptions,
): string {
  const document = parseDocument(markdown);
  const target = requireRecord(document, options.targetId);
  const resolution = {
    status: "resolved",
    ...(options.summary ? { resolved: options.summary } : {}),
  } as const;

  if (target.kind === "comment") {
    document.comments.set(target.id, { ...target.record, ...resolution });
  } else {
    document.suggestions.set(target.id, { ...target.record, ...resolution });
  }

  return serializeDocument(document);
}

/** A record found in a document, and which of the two maps holds it. */
type FoundRecord =
  | { kind: "comment"; id: CommentId; record: CommentRecord }
  | { kind: "suggestion"; id: SuggestionId; record: SuggestionRecord };

/**
 * The record `rawId` names, or an error saying which way it is unusable.
 *
 * Two failures are distinguished, because a caller told only "not found" about
 * a record it can read in the file learns nothing: the record is absent, or it
 * is present with nothing to hold it in place. The second is asked of
 * {@link retainRecords}, which is where the retention rule lives.
 */
function requireRecord(document: RfmDocument, rawId: string): FoundRecord {
  const found = findRecord(document, rawId);
  if (!found) throw new Error(`Review item not found: ${rawId}`);

  const retained = retainRecords(document);
  const isRetained =
    found.kind === "comment"
      ? retained.comments.has(found.id)
      : retained.suggestions.has(found.id);
  if (!isRetained) {
    throw new Error(
      `Review item has no anchor: ${rawId}. The endmatter holds it, but nothing in the body carries its id and it is not a document comment, so no write can keep it.`,
    );
  }

  return found;
}

function findRecord(document: RfmDocument, rawId: string): FoundRecord | null {
  const commentId = parseCommentId(rawId);
  const comment = commentId ? document.comments.get(commentId) : undefined;
  if (commentId && comment) {
    return { kind: "comment", id: commentId, record: comment };
  }

  const suggestionId = parseSuggestionId(rawId);
  const suggestion = suggestionId
    ? document.suggestions.get(suggestionId)
    : undefined;
  if (suggestionId && suggestion) {
    return { kind: "suggestion", id: suggestionId, record: suggestion };
  }

  return null;
}

function commentIdFor(
  requestedId: string | undefined,
  document: RfmDocument,
): CommentId {
  if (requestedId === undefined) {
    return new RecordIdAllocator(document).allocateCommentId();
  }

  const id = parseCommentId(requestedId);
  if (!id) {
    throw new Error(
      `Invalid comment id: ${requestedId}. Comment ids match \`rd-c<number>\`.`,
    );
  }

  // An id carried by a body anchor is spoken for even when no record uses it:
  // binding a new record to it would bind it to that unrelated span.
  if (RecordIdAllocator.isIdInUse(document, id)) {
    throw new Error(`Comment id already in use: ${requestedId}`);
  }

  return id;
}
