import type { RfmDocument } from "./document.js";

/**
 * Record ids.
 *
 * A comment id and a suggestion id are both strings matching `rd-c<n>` and
 * `rd-s<n>`, and transposing one for the other is a mistake the compiler can
 * catch, so each carries its own brand. The only way to obtain a branded id is
 * to parse a string that matches its pattern, or to allocate a fresh one from a
 * {@link RecordIdAllocator}. This module deliberately exports nothing that
 * turns an unvalidated string into a branded id — no cast, no id constructor,
 * no such helper; that absence is what makes the brand a guarantee rather than
 * a convention.
 */

declare const commentIdBrand: unique symbol;
declare const suggestionIdBrand: unique symbol;

export type CommentId = string & { readonly [commentIdBrand]: true };
export type SuggestionId = string & { readonly [suggestionIdBrand]: true };
export type RecordId = CommentId | SuggestionId;

const commentIdPrefix = "rd-c";
const suggestionIdPrefix = "rd-s";
const commentIdPattern = /^rd-c[0-9]+$/;
const suggestionIdPattern = /^rd-s[0-9]+$/;

/** The id `value` denotes, or null when it is not a comment id. */
export function parseCommentId(value: string): CommentId | null {
  return commentIdPattern.test(value) ? (value as CommentId) : null;
}

/** The id `value` denotes, or null when it is not a suggestion id. */
export function parseSuggestionId(value: string): SuggestionId | null {
  return suggestionIdPattern.test(value) ? (value as SuggestionId) : null;
}

/** The id `value` denotes, or null when it is neither a comment nor a suggestion id. */
export function parseRecordId(value: string): RecordId | null {
  return parseCommentId(value) ?? parseSuggestionId(value);
}

function idNumber(id: string, prefix: string): number {
  return Number.parseInt(id.slice(prefix.length), 10);
}

/**
 * The highest number any id of one kind carries in `document`, or 0 when it
 * carries none.
 *
 * Both the anchors in the body and the keys of the records are scanned,
 * because a reply and a document-scope comment have no anchor and would
 * otherwise be invisible.
 */
function highestNumberIn(
  document: RfmDocument,
  prefix: string,
  recordKeys: Iterable<string>,
  belongsToKind: (id: string) => boolean,
): number {
  let highest = 0;

  for (const id of recordKeys) {
    highest = Math.max(highest, idNumber(id, prefix));
  }

  for (const anchor of document.anchors) {
    if (belongsToKind(anchor.id)) {
      highest = Math.max(highest, idNumber(anchor.id, prefix));
    }
  }

  return highest;
}

/**
 * Mints record ids that nothing it has seen is using.
 *
 * Each kind's mark only ever rises. Allocating by scanning the document about
 * to be written reissues the id of a record that document no longer holds, so
 * an undo restoring that record produces two of it, and nothing downstream can
 * detect the collision. Counting up from a mark that never falls cannot.
 *
 * Scanning also costs whatever materializing the document costs, which for a
 * live editor is a full serialize and reparse of the whole file per id.
 */
export class RecordIdAllocator {
  #highestCommentNumber = 0;
  #highestSuggestionNumber = 0;

  /** An allocator that will not issue any id `document` already uses. */
  constructor(document: RfmDocument) {
    this.reserve(document);
  }

  /**
   * Raise the marks so no id `document` uses can be issued.
   *
   * Ids issued earlier stay spoken for: a document holding lower numbers, or
   * none, lowers nothing. Call this whenever the document is replaced from
   * outside — a reload, or a write by another process.
   */
  reserve(document: RfmDocument): void {
    this.#highestCommentNumber = Math.max(
      this.#highestCommentNumber,
      highestNumberIn(
        document,
        commentIdPrefix,
        document.comments.keys(),
        (id) => parseCommentId(id) !== null,
      ),
    );
    this.#highestSuggestionNumber = Math.max(
      this.#highestSuggestionNumber,
      highestNumberIn(
        document,
        suggestionIdPrefix,
        document.suggestions.keys(),
        (id) => parseSuggestionId(id) !== null,
      ),
    );
  }

  /**
   * Whether `id` is spoken for anywhere in `document`.
   *
   * Both the endmatter record keys and the body anchors are scanned, which is
   * the same surface {@link reserve} raises the marks from. An anchor whose
   * record the endmatter never described still carries its id, so binding a new
   * record to that id would bind it to that unrelated span.
   *
   * Static because the question is about one document, not about what this
   * allocator has issued: an allocator's marks only rise, so they answer
   * "already handed out", never "present here".
   */
  static isIdInUse(document: RfmDocument, id: RecordId): boolean {
    const commentId = parseCommentId(id);
    if (commentId && document.comments.has(commentId)) return true;

    const suggestionId = parseSuggestionId(id);
    if (suggestionId && document.suggestions.has(suggestionId)) return true;

    return document.anchors.some((anchor) => anchor.id === id);
  }

  /** A comment id this allocator has not issued and has not reserved. */
  allocateCommentId(): CommentId {
    this.#highestCommentNumber += 1;

    return `${commentIdPrefix}${this.#highestCommentNumber.toString()}` as CommentId;
  }

  /** A suggestion id this allocator has not issued and has not reserved. */
  allocateSuggestionId(): SuggestionId {
    this.#highestSuggestionNumber += 1;

    return `${suggestionIdPrefix}${this.#highestSuggestionNumber.toString()}` as SuggestionId;
  }
}
