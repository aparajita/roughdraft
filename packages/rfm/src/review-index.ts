import type { Anchor } from "./anchors.js";
import { parseDocument, type RfmDocument, retainRecords } from "./document.js";
import { RFM_VERSION } from "./endmatter.js";
import {
  type CommentId,
  parseSuggestionId,
  type RecordId,
  type SuggestionId,
} from "./ids.js";

/**
 * The review interchange index.
 *
 * The Markdown file is the normative storage format; this is the JSON view of
 * its review layer, shaped by
 * `docs/spec/roughdraft-flavored-markdown.schema.json`. That schema sets
 * `additionalProperties: false`, so an index carries comments and suggestions
 * and nothing else — no flat item list, no diagnostics, no summary.
 */

export type CommentAnchorKind = "span" | "point";
export type SuggestionKind = "insert" | "delete" | "replace";

export interface CommentIndexAnchor {
  kind: CommentAnchorKind;
  /** The anchored text. Absent for a point anchor, which has none. */
  text?: string;
  /** The anchored content before Markdown rendering. */
  markdown?: string;
}

export interface CommentIndexEntry {
  id: CommentId;
  body: string;
  by: string;
  at: string;
  re?: RecordId;
  scope?: "document";
  anchor?: CommentIndexAnchor;
  status?: "resolved";
  resolved?: string;
  metadata?: Record<string, unknown>;
}

export interface SuggestionIndexEntry {
  id: SuggestionId;
  /** Read from the anchor element, never from the record. */
  kind: SuggestionKind;
  by: string;
  at: string;
  /** The inserted or deleted text, for an insert or a delete. */
  text?: string;
  /** The text the document has now, for a replace. */
  oldText?: string;
  /** The text the edit proposes, for a replace. */
  newText?: string;
  /** Ids of comments whose `re` names this suggestion. */
  commentIds?: CommentId[];
  status?: "resolved";
  resolved?: string;
  metadata?: Record<string, unknown>;
}

export interface RfmReviewIndex {
  format: "roughdraft-flavored-markdown";
  version: typeof RFM_VERSION;
  comments: CommentIndexEntry[];
  suggestions: SuggestionIndexEntry[];
}

export interface RfmReviewIndexSummary {
  comments: number;
  replies: number;
  suggestions: number;
  unresolved: number;
}

interface SuggestionShape {
  kind: SuggestionKind;
  text?: string;
  oldText?: string;
  newText?: string;
}

type AnchorFacts =
  | { commentId: CommentId; anchor: CommentIndexAnchor }
  | { suggestionId: SuggestionId; shape: SuggestionShape };

/**
 * What an anchor contributes to the index.
 *
 * The switch is exhaustive over the anchor union and its default branch
 * assigns to `never`, so a new anchor kind fails to compile here rather than
 * falling through and producing an entry of the wrong shape.
 */
function anchorFacts(anchor: Anchor): AnchorFacts {
  switch (anchor.kind) {
    case "span":
      return {
        commentId: anchor.id,
        anchor: { kind: "span", text: anchor.text, markdown: anchor.markdown },
      };
    case "point":
      return { commentId: anchor.id, anchor: { kind: "point" } };
    case "insert":
      return {
        suggestionId: anchor.id,
        shape: { kind: "insert", text: anchor.text },
      };
    case "delete":
      return {
        suggestionId: anchor.id,
        shape: { kind: "delete", text: anchor.text },
      };
    case "replace":
      return {
        suggestionId: anchor.id,
        shape: {
          kind: "replace",
          oldText: anchor.oldText,
          newText: anchor.newText,
        },
      };
    default: {
      const unreachable: never = anchor;
      return unreachable;
    }
  }
}

/**
 * The review index for an already parsed document.
 *
 * The index describes the review layer the document actually carries, so it is
 * built from the retained records rather than from everything the endmatter
 * happens to hold: an unretained record is dropped by the next write, and
 * reporting it here would show the reader a comment that is about to vanish.
 * Retention has one definition, in `retainRecords`.
 */
export function buildReviewIndex(document: RfmDocument): RfmReviewIndex {
  const retained = retainRecords(document);
  const commentAnchors = new Map<CommentId, CommentIndexAnchor>();
  const suggestionShapes = new Map<SuggestionId, SuggestionShape>();

  for (const anchor of document.anchors) {
    const facts = anchorFacts(anchor);

    if ("commentId" in facts) {
      if (!commentAnchors.has(facts.commentId)) {
        commentAnchors.set(facts.commentId, facts.anchor);
      }
      continue;
    }

    if (!suggestionShapes.has(facts.suggestionId)) {
      suggestionShapes.set(facts.suggestionId, facts.shape);
    }
  }

  const commentIdsBySuggestion = new Map<SuggestionId, CommentId[]>();
  for (const [id, record] of retained.comments) {
    if (!record.re) continue;

    const target = parseSuggestionId(record.re);
    if (!target || !suggestionShapes.has(target)) continue;

    const ids = commentIdsBySuggestion.get(target) ?? [];
    ids.push(id);
    commentIdsBySuggestion.set(target, ids);
  }

  const comments: CommentIndexEntry[] = [];
  for (const [id, record] of retained.comments) {
    const anchor = commentAnchors.get(id);
    comments.push({
      id,
      body: record.body,
      by: record.by,
      at: record.at,
      ...(record.re ? { re: record.re } : {}),
      ...(record.scope ? { scope: record.scope } : {}),
      ...(anchor && !record.scope ? { anchor } : {}),
      ...(record.status ? { status: record.status } : {}),
      ...(record.resolved ? { resolved: record.resolved } : {}),
      ...(Object.keys(record.metadata).length > 0
        ? { metadata: record.metadata }
        : {}),
    });
  }

  const suggestions: SuggestionIndexEntry[] = [];
  for (const [id, record] of retained.suggestions) {
    // Retention already required an anchor for every suggestion, so this is a
    // lookup rather than a filter; the operation the entry reports lives in
    // the anchor's shape, not in the record.
    const shape = suggestionShapes.get(id);
    if (!shape) continue;

    const commentIds = commentIdsBySuggestion.get(id);
    suggestions.push({
      id,
      kind: shape.kind,
      by: record.by,
      at: record.at,
      ...(shape.text === undefined ? {} : { text: shape.text }),
      ...(shape.oldText === undefined ? {} : { oldText: shape.oldText }),
      ...(shape.newText === undefined ? {} : { newText: shape.newText }),
      ...(commentIds ? { commentIds } : {}),
      ...(record.status ? { status: record.status } : {}),
      ...(record.resolved ? { resolved: record.resolved } : {}),
      ...(Object.keys(record.metadata).length > 0
        ? { metadata: record.metadata }
        : {}),
    });
  }

  return {
    format: "roughdraft-flavored-markdown",
    version: RFM_VERSION,
    comments,
    suggestions,
  };
}

/** The review index for a Markdown document. */
export function extractRoughdraftReviewIndex(markdown: string): RfmReviewIndex {
  return buildReviewIndex(parseDocument(markdown));
}

/**
 * Count what an index holds.
 *
 * `comments` counts every comment record, replies included; `replies` counts
 * those carrying `re`, so replies are counted in both. `unresolved` counts
 * comment and suggestion records without `status: "resolved"`.
 *
 * This lives beside the record types rather than at its call sites so that
 * what counts as a reply, and what counts as unresolved, has one definition.
 */
export function summarizeReviewIndex(
  index: RfmReviewIndex,
): RfmReviewIndexSummary {
  const replies = index.comments.filter((comment) => comment.re).length;
  const unresolved = [...index.comments, ...index.suggestions].filter(
    (entry) => entry.status !== "resolved",
  ).length;

  return {
    comments: index.comments.length,
    replies,
    suggestions: index.suggestions.length,
    unresolved,
  };
}
