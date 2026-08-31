import type { SuggestionAttrs, SuggestionKind } from "./editor-extensions";
import {
  buildCommentThreads,
  expandCommentThreadIds,
  flattenCommentThreads,
  getOrderedAnchorComments,
  type ReviewComment,
} from "./review";

interface CommentAnchorMeasurement {
  commentIds: string[];
  anchorTop: number;
  anchorBottom: number;
}

export interface CommentGroupAnchor {
  key: string;
  commentIds: string[];
  anchorTop: number;
  anchorBottom: number;
}

interface CommentRailLayout extends CommentGroupAnchor {
  railTop: number;
  railBottom: number;
  height: number;
}

export interface CommentThreadRailItem {
  key: string;
  anchorGroupKey: string;
  rootCommentId: string;
  commentIds: string[];
  anchorTop: number;
  anchorBottom: number;
}

/**
 * A suggestion as measured in the rendered document: its mark attributes, the
 * text on each side of the edit, the ids of the comments filed against it, and
 * the vertical extent of its anchor.
 */
export interface SuggestionAnchorItem {
  suggestionId: string;
  attrs: SuggestionAttrs;
  kind: SuggestionKind;
  oldText: string;
  newText: string;
  commentIds: string[];
  anchorTop: number;
  anchorBottom: number;
}

/**
 * What a suggestion does to the text, as the format names it. The mark layer's
 * {@link SuggestionKind} splits a replacement into its two halves; this is the
 * whole edit.
 */
export type SuggestionOperation = "insert" | "delete" | "replace";

const SUGGESTION_OPERATIONS: Record<SuggestionKind, SuggestionOperation> = {
  insert: "insert",
  delete: "delete",
  "replace-old": "replace",
  "replace-new": "replace",
};

/**
 * The operation a suggestion performs.
 *
 * It is derived from the anchor markup and never read from an endmatter
 * record: the record has no operation field, so the two cannot disagree.
 */
export function suggestionOperationOf(
  kind: SuggestionKind,
): SuggestionOperation {
  return SUGGESTION_OPERATIONS[kind];
}

interface CommentThreadRailLayout extends CommentThreadRailItem {
  railTop: number;
  railBottom: number;
  height: number;
}

interface AnchoredRailItem {
  key: string;
  anchorTop: number;
  anchorBottom: number;
}

export type AnchoredRailLayout<T extends AnchoredRailItem> = T & {
  railTop: number;
  railBottom: number;
  height: number;
};

/**
 * A comment anchor in the document is the anchor element itself: it carries the
 * outermost comment id as its `id`, and the ids of any comments nested on the
 * same range as a JSON array in `data-rd-nested`.
 */
export const COMMENT_ANCHOR_SELECTOR = 'span[id^="rd-c"]';

/** The anchor element of an insertion: `<ins id="rd-sN">new</ins>`. */
export const INSERTION_ANCHOR_SELECTOR = 'ins[id^="rd-s"]';

/** The anchor element of a deletion: `<del id="rd-sN">old</del>`. */
export const DELETION_ANCHOR_SELECTOR = 'del[id^="rd-s"]';

/**
 * The anchor element of a replacement:
 * `<span id="rd-sN"><del>old</del><ins>new</ins></span>`.
 */
export const REPLACEMENT_ANCHOR_SELECTOR = 'span[id^="rd-s"]';

interface CommentAnchorElementLike {
  id: string;
  dataset: {
    rdNested?: string;
  };
  getBoundingClientRect: () => {
    top: number;
    bottom: number;
  };
}

export function readCommentAnchorIds(
  element: Pick<CommentAnchorElementLike, "id" | "dataset">,
): string[] {
  if (!element.id) return [];

  return [
    ...new Set([element.id, ...parseCommentIds(element.dataset.rdNested)]),
  ];
}

export function normalizeCommentMeasurement(
  value: number,
  measurementScale = 1,
) {
  if (!Number.isFinite(measurementScale) || measurementScale <= 0) {
    return value;
  }

  return value / measurementScale;
}

function parseCommentIds(value: string | null | undefined): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((entry): entry is string => typeof entry === "string"),
      ),
    ];
  } catch {
    return [];
  }
}

function getCommentGroupKey(commentIds: string[]): string {
  return [...new Set(commentIds)].sort().join("::");
}

export function getPreferredCommentId(
  commentIds: string[],
  currentCommentId: string | null,
): string | null {
  if (currentCommentId && commentIds.includes(currentCommentId)) {
    return currentCommentId;
  }

  return commentIds[0] ?? null;
}

/**
 * The root of the thread `commentId` belongs to, or null when no comment is
 * filed under that id.
 *
 * The walk upward is bounded because the reply links cannot form a cycle: the
 * parser breaks every cycle it reads, and the only other way a comment gets a
 * parent is `createReviewComment`, which attaches a freshly allocated id to a
 * parent that already exists.
 */
export function getRootThreadIdForCommentId(
  commentId: string | null,
  comments: ReadonlyMap<string, ReviewComment>,
): string | null {
  if (!commentId) return null;

  let currentComment = comments.get(commentId);

  while (currentComment) {
    const parentCommentId = currentComment.parentCommentId;

    if (!parentCommentId || !comments.has(parentCommentId)) {
      return currentComment.id;
    }

    currentComment = comments.get(parentCommentId);
  }

  return null;
}

export function getCommentAnchorMeasurements(
  anchorElements: Iterable<CommentAnchorElementLike>,
  containerTop: number,
  measurementScale = 1,
): CommentAnchorMeasurement[] {
  const measurements: CommentAnchorMeasurement[] = [];

  for (const element of anchorElements) {
    const commentIds = readCommentAnchorIds(element);
    if (commentIds.length === 0) continue;

    const rect = element.getBoundingClientRect();
    measurements.push({
      commentIds,
      anchorTop: normalizeCommentMeasurement(
        rect.top - containerTop,
        measurementScale,
      ),
      anchorBottom: normalizeCommentMeasurement(
        rect.bottom - containerTop,
        measurementScale,
      ),
    });
  }

  return measurements;
}

export function groupCommentAnchorMeasurements(
  measurements: CommentAnchorMeasurement[],
): CommentGroupAnchor[] {
  const grouped = new Map<string, CommentGroupAnchor>();

  for (const measurement of measurements) {
    const key = getCommentGroupKey(measurement.commentIds);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        key,
        commentIds: measurement.commentIds,
        anchorTop: measurement.anchorTop,
        anchorBottom: measurement.anchorBottom,
      });
      continue;
    }

    existing.anchorTop = Math.min(existing.anchorTop, measurement.anchorTop);
    existing.anchorBottom = Math.max(
      existing.anchorBottom,
      measurement.anchorBottom,
    );
  }

  return [...grouped.values()].sort(
    (left, right) => left.anchorTop - right.anchorTop,
  );
}

export function buildCommentThreadRailItems(
  groups: CommentGroupAnchor[],
  comments: ReadonlyMap<string, ReviewComment>,
): CommentThreadRailItem[] {
  const items: CommentThreadRailItem[] = [];

  for (const group of groups) {
    // Only a thread's root carries an anchor, so the group's ids name roots
    // alone. Pulling in each root's descendants is what puts replies in the
    // thread; without it a reply exists in the endmatter and renders nowhere.
    const visibleComments = expandCommentThreadIds(group.commentIds, comments)
      .map((commentId) => comments.get(commentId))
      .filter((comment): comment is ReviewComment => Boolean(comment));

    if (visibleComments.length === 0) continue;

    for (const thread of buildCommentThreads(visibleComments)) {
      const threadComments = flattenCommentThreads([thread]);

      if (threadComments.length === 0) continue;

      items.push({
        key: thread.comment.id,
        anchorGroupKey: group.key,
        rootCommentId: thread.comment.id,
        commentIds: threadComments.map((comment) => comment.id),
        anchorTop: group.anchorTop,
        anchorBottom: group.anchorBottom,
      });
    }
  }

  return items;
}

export function resolveCommentRailLayouts(
  groups: CommentGroupAnchor[],
  heights: Record<string, number>,
  gap = 16,
): CommentRailLayout[] {
  let previousRailBottom = 0;

  return groups.map((group) => {
    const height = heights[group.key] ?? 120;
    const railTop = Math.max(
      group.anchorTop,
      previousRailBottom === 0 ? group.anchorTop : previousRailBottom + gap,
    );
    const railBottom = railTop + height;
    previousRailBottom = railBottom;

    return {
      ...group,
      railTop,
      railBottom,
      height,
    };
  });
}

export function resolveAnchoredRailLayouts<T extends AnchoredRailItem>(
  items: T[],
  heights: Record<string, number>,
  activeKey: string | null,
  gap = 16,
  defaultHeight = 120,
): Array<AnchoredRailLayout<T>> {
  if (items.length === 0) return [];

  const activeIndex = Math.max(
    0,
    activeKey ? items.findIndex((item) => item.key === activeKey) : 0,
  );

  const resolved = new Array<AnchoredRailLayout<T>>(items.length);
  const getHeight = (item: T) => heights[item.key] ?? defaultHeight;

  const activeItem = items[activeIndex] ?? items[0];
  if (!activeItem) return [];

  const activeHeight = getHeight(activeItem);
  resolved[activeIndex] = {
    ...activeItem,
    railTop: activeItem.anchorTop,
    railBottom: activeItem.anchorTop + activeHeight,
    height: activeHeight,
  };

  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const item = items[index];
    const nextLayout = resolved[index + 1];

    if (!item || !nextLayout) continue;

    const height = getHeight(item);
    const railTop = Math.min(item.anchorTop, nextLayout.railTop - gap - height);

    resolved[index] = {
      ...item,
      railTop,
      railBottom: railTop + height,
      height,
    };
  }

  for (let index = activeIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    const previousLayout = resolved[index - 1];

    if (!item || !previousLayout) continue;

    const height = getHeight(item);
    const railTop = Math.max(item.anchorTop, previousLayout.railBottom + gap);

    resolved[index] = {
      ...item,
      railTop,
      railBottom: railTop + height,
      height,
    };
  }

  const firstRailTop = resolved[0]?.railTop ?? 0;
  if (firstRailTop < 0) {
    const offset = -firstRailTop;
    return resolved.map((layout) => ({
      ...layout,
      railTop: layout.railTop + offset,
      railBottom: layout.railBottom + offset,
    }));
  }

  return resolved;
}

export function resolveCommentThreadRailLayouts(
  items: CommentThreadRailItem[],
  heights: Record<string, number>,
  selectedRootThreadId: string | null,
  gap = 16,
): CommentThreadRailLayout[] {
  const activeItem =
    selectedRootThreadId == null
      ? null
      : (items.find((item) => item.rootCommentId === selectedRootThreadId) ??
        null);

  return resolveAnchoredRailLayouts(
    items,
    heights,
    activeItem?.key ?? null,
    gap,
  );
}

/**
 * One navigable, one-chip unit of review.
 *
 * Exactly one entry is current at a time, so an entry is the whole of what a
 * reviewer can be looking at: there is no state in which a comment and a
 * suggestion are both current.
 *
 * An entry's `id` is unique across the whole sequence, because comment ids
 * (`rd-c*`) and suggestion ids (`rd-s*`) share one id space in the document.
 * It is the root comment id for a document comment and a comment thread, and
 * the suggestion id for a suggestion.
 *
 * `commentIds` is the entry's full ordered membership, root first for a
 * thread. A comment filed against a suggestion belongs to that suggestion's
 * entry and never forms an entry of its own; a comment reachable through `re`
 * from a thread root belongs to that root's entry and never forms one either.
 */
export type ReviewEntry =
  | { kind: "document-comment"; id: string; commentIds: string[]; at: string }
  | {
      kind: "comment-thread";
      id: string;
      commentIds: string[];
      anchorGroupKey: string;
      anchorTop: number;
      anchorBottom: number;
    }
  | {
      kind: "suggestion";
      id: string;
      operation: SuggestionOperation;
      oldText: string;
      newText: string;
      commentIds: string[];
      anchorTop: number;
      anchorBottom: number;
    };

/** An entry whose place in the sequence is the place of its anchor. */
type AnchoredReviewEntry = Extract<
  ReviewEntry,
  { kind: "comment-thread" | "suggestion" }
>;

function compareAnchoredEntries(
  left: AnchoredReviewEntry,
  right: AnchoredReviewEntry,
): number {
  return (
    left.anchorTop - right.anchorTop ||
    left.anchorBottom - right.anchorBottom ||
    left.id.localeCompare(right.id)
  );
}

/**
 * The document's entries as one ordered sequence.
 *
 * Preconditions: `commentGroups` are the measured comment anchors, as
 * {@link groupCommentAnchorMeasurements} returns them, and `suggestions` are
 * the measured suggestion anchors. Both carry positions in one coordinate
 * space — distances from the top of the same container — so they can be
 * ordered against each other. `comments` holds every comment the document
 * has, replies included; an id named by an anchor but absent from the map
 * contributes nothing.
 *
 * Ordering: every `scope: "document"` root comment first, ascending by
 * `createdAt`; then the anchored entries — comment threads and suggestions
 * interleaved — ascending by `anchorTop`, ties broken by `anchorBottom` and
 * then by `id`. Both halves break their last tie on `id`, which is unique, so
 * the order is total and stable against the input order.
 *
 * Every returned `id` is distinct: a suggestion id can never equal a comment
 * id, each anchor group yields each thread root once, and a comment claimed by
 * a suggestion is excluded from the comment-thread entries.
 */
export function buildReviewEntries(
  commentGroups: CommentGroupAnchor[],
  suggestions: SuggestionAnchorItem[],
  comments: ReadonlyMap<string, ReviewComment>,
): ReviewEntry[] {
  const suggestionEntries = suggestions.map((suggestion) => ({
    kind: "suggestion" as const,
    id: suggestion.suggestionId,
    operation: suggestionOperationOf(suggestion.kind),
    oldText: suggestion.oldText,
    newText: suggestion.newText,
    commentIds: getOrderedAnchorComments(suggestion.commentIds, comments).map(
      (comment) => comment.id,
    ),
    anchorTop: suggestion.anchorTop,
    anchorBottom: suggestion.anchorBottom,
  }));

  const claimedCommentIds = new Set(
    suggestionEntries.flatMap((entry) => entry.commentIds),
  );

  const unclaimedGroups = commentGroups
    .map((group) => ({
      ...group,
      commentIds: group.commentIds.filter(
        (commentId) => !claimedCommentIds.has(commentId),
      ),
    }))
    .filter((group) => group.commentIds.length > 0);

  const threadEntries = buildCommentThreadRailItems(
    unclaimedGroups,
    comments,
  ).map((item) => ({
    kind: "comment-thread" as const,
    id: item.rootCommentId,
    commentIds: item.commentIds,
    anchorGroupKey: item.anchorGroupKey,
    anchorTop: item.anchorTop,
    anchorBottom: item.anchorBottom,
  }));

  const documentEntries = [...comments.values()]
    .filter(
      (comment) =>
        comment.scope === "document" &&
        !(comment.parentCommentId && comments.has(comment.parentCommentId)),
    )
    .map((comment) => ({
      kind: "document-comment" as const,
      id: comment.id,
      commentIds: getOrderedAnchorComments([comment.id], comments).map(
        (member) => member.id,
      ),
      at: comment.createdAt,
    }))
    .sort(
      (left, right) =>
        left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );

  const anchoredEntries: AnchoredReviewEntry[] = [
    ...suggestionEntries,
    ...threadEntries,
  ];

  return [...documentEntries, ...anchoredEntries.sort(compareAnchoredEntries)];
}

/**
 * The entry that becomes current once `removedEntryId` is gone.
 *
 * Accepting or rejecting a suggestion makes the next entry in the sequence
 * current, and removing the entry shifts every later entry one place forward,
 * so the entry now sitting at the removed entry's index is the next one. Past
 * the end of the shortened sequence the last entry becomes current, and an
 * empty sequence leaves nothing current.
 *
 * Returns null when `removedEntryId` is not in `previousEntries`: the caller's
 * sequence is not the one the removal happened in, and no entry follows.
 */
export function resolveNextCurrentEntry(
  previousEntries: ReviewEntry[],
  nextEntries: ReviewEntry[],
  removedEntryId: string,
): string | null {
  const removedIndex = previousEntries.findIndex(
    (entry) => entry.id === removedEntryId,
  );

  if (removedIndex < 0) return null;

  return (
    nextEntries[removedIndex]?.id ??
    nextEntries[nextEntries.length - 1]?.id ??
    null
  );
}

/** Where a newly current anchor is put: one third down the viewport. */
const ANCHOR_SCROLL_VIEWPORT_FRACTION = 1 / 3;

/**
 * How far to scroll so that a newly current anchor is on screen, or null when
 * it already is.
 *
 * `top` and `bottom` are viewport-relative, as `getBoundingClientRect` returns
 * them; the result is a delta in the same direction as `window.scrollBy`.
 */
export function resolveAnchorScroll(
  anchor: { top: number; bottom: number },
  viewportHeight: number,
): number | null {
  if (anchor.top >= 0 && anchor.bottom <= viewportHeight) return null;

  return anchor.top - viewportHeight * ANCHOR_SCROLL_VIEWPORT_FRACTION;
}
