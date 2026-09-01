import type { Mark } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

/**
 * The two kinds of review markup a reviewer can place on a selection. Both are
 * stored as marks and serialized to inline elements, so both face the same
 * limits on where they can go; the subject only decides which noun the refusal
 * names.
 */
export type ReviewMarkupSubject = "comment" | "suggestion";

const SUBJECT_NOUNS: Record<ReviewMarkupSubject, string> = {
  comment: "A comment",
  suggestion: "A suggestion",
};

/**
 * The reason a selection cannot carry review markup, as a sentence completed by
 * the subject's noun. Each entry states what the reviewer should select
 * instead, except where nothing in range can be selected.
 */
const BLOCKED_REASONS = {
  /**
   * A comment anchors to one contiguous range, and anchors nest only when one
   * range contains the other — that nesting is what an anchor's `commentIds`
   * array represents. A selection crossing the edge of an existing anchor,
   * covering part of it and part of the text outside it, has no representation
   * in the format, so it is refused rather than widened.
   */
  partialAnchorOverlap: (subject: string) =>
    `${subject} cannot start or end inside an existing comment. Select the whole comment, or a range inside it.`,

  /**
   * A code block carries no marks, so the editor drops review markup applied
   * inside one. The command still reports success, which would leave a record
   * with nothing anchoring it and no sign to the reviewer that anything went
   * wrong. No range inside the block can hold the markup, so the message offers
   * no alternative selection.
   */
  insideCodeBlock: (subject: string) =>
    `${subject} cannot be placed inside a code block.`,

  /**
   * Inline code is a single code span in the markdown. Writing markup partway
   * through it splits the span around the markup, turning one span into
   * several and changing what the document says. Markup wrapping the whole span
   * sits outside it and round-trips, so that selection stays available.
   */
  insideInlineCode: (subject: string) =>
    `${subject} cannot start or end inside inline code. Select the whole code span, or a range outside it.`,

  /**
   * An anchor is inline content, so the text it covers lies within one block. A
   * range spanning a block boundary has no anchor that can hold it, and the
   * format requires a writer offered one to refuse it rather than write markup
   * it cannot read back.
   */
  crossedBlock: (subject: string) =>
    `${subject} cannot span more than one block. Select a range within a single paragraph, heading or list item.`,
} as const;

interface MarkRange {
  from: number;
  to: number;
  mark: Mark;
}

/**
 * The contiguous ranges a mark covers. The mark is stored per text node, so
 * adjacent nodes carrying an equal mark are one range: what the document
 * records is a single element spanning them.
 */
function getMarkRanges(editor: Editor, markName: string): MarkRange[] {
  const markType = editor.state.schema.marks[markName];
  if (!markType) return [];

  const ranges: MarkRange[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const mark = node.marks.find((candidate) => candidate.type === markType);
    if (!mark) return;

    const previous = ranges.at(-1);

    if (previous && previous.to === pos && previous.mark.eq(mark)) {
      previous.to = pos + node.nodeSize;
      return;
    }

    ranges.push({ from: pos, to: pos + node.nodeSize, mark });
  });

  return ranges;
}

/**
 * The comment anchor whose range exactly matches the given range, if any. A
 * selection that merely contains or is contained by an anchor is a new,
 * distinct nested comment; only an exact match reuses the same anchor's
 * thread rather than adding a second one over identical text.
 */
export function findExactCommentAnchorMatch(
  editor: Editor,
  from: number,
  to: number,
): Mark | null {
  return (
    getMarkRanges(editor, "commentAnchor").find(
      (range) => range.from === from && range.to === to,
    )?.mark ?? null
  );
}

function selectionPartiallyOverlapsAnchor(editor: Editor): boolean {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;

  return getMarkRanges(editor, "commentAnchor").some((range) => {
    const intersects = range.from < to && range.to > from;
    if (!intersects) return false;

    const containsSelection = range.from <= from && range.to >= to;
    const containedBySelection = range.from >= from && range.to <= to;

    return !containsSelection && !containedBySelection;
  });
}

function selectionInsideCodeBlock(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;

  return (
    $from.parent.type.spec.code === true || $to.parent.type.spec.code === true
  );
}

/**
 * Whether an endpoint of the selection lands inside a code span rather than at
 * its edge. A selection containing a whole span is not entering it: the markup
 * wraps the span from outside, which the format expresses.
 */
function selectionEntersInlineCode(editor: Editor): boolean {
  const { from, to } = editor.state.selection;

  return getMarkRanges(editor, "code").some((range) => {
    const intersects = range.from < to && range.to > from;
    if (!intersects) return false;

    return !(range.from >= from && range.to <= to);
  });
}

function selectionCrossesBlock(editor: Editor): boolean {
  const { $from, $to, empty } = editor.state.selection;

  return !empty && !$from.sameParent($to);
}

/**
 * Why the current selection cannot carry review markup, or `null` when it can.
 *
 * The one test that decides whether an action is offered decides whether it
 * happens, so the menu, the shortcut and the handler all ask this and cannot
 * disagree about which selections are legal.
 */
export function getReviewMarkupBlockedReason(
  editor: Editor,
  subject: ReviewMarkupSubject,
): string | null {
  const noun = SUBJECT_NOUNS[subject];

  if (selectionPartiallyOverlapsAnchor(editor)) {
    return BLOCKED_REASONS.partialAnchorOverlap(noun);
  }

  if (selectionInsideCodeBlock(editor)) {
    return BLOCKED_REASONS.insideCodeBlock(noun);
  }

  if (selectionEntersInlineCode(editor)) {
    return BLOCKED_REASONS.insideInlineCode(noun);
  }

  return selectionCrossesBlock(editor)
    ? BLOCKED_REASONS.crossedBlock(noun)
    : null;
}
