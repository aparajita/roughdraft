import type {
  Mark as ProseMirrorMark,
  MarkType as ProseMirrorMarkType,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import {
  collectSuggestionRanges,
  INLINE_LEAF_TEXT,
  type SuggestionAttrs,
  type SuggestionKind,
} from "./editor-extensions";

/**
 * Mints the attributes for a new suggestion. Ids are allocated against the
 * document being reviewed, which only the caller can read, so every entry point
 * here takes the allocation as a parameter rather than reaching for a document.
 */
export type CreateSuggestionAttrs = (kind: SuggestionKind) => SuggestionAttrs;

/** Which side of a collapsed caret a removal consumes. */
export type RemovalDirection = "backward" | "forward";

/** How much a removal consumes: one character, or one whole word. */
export type RemovalGranularity = "character" | "word";

/**
 * What a run of inline content is, as far as the review is concerned.
 *
 * - `proposed` — the reviewer proposed adding it, so removing it deletes it
 *   outright: it was never part of the document under review.
 * - `original` — it is the document under review, so removing it marks it
 *   deleted rather than taking it out.
 * - `removed` — a suggestion already proposes removing it, so a removal leaves
 *   the mark it carries. Re-marking a replacement's old half would give it an
 *   id its new half does not share, and a half with no partner cannot be
 *   written as a replacement.
 */
export type SuggestedTextStanding = "proposed" | "original" | "removed";

/** A half-open range of the document, and how suggesting mode must treat it. */
export interface SuggestedRangeSegment {
  from: number;
  to: number;
  standing: SuggestedTextStanding;
}

/** A half-open range of the document. */
interface DocumentRange {
  from: number;
  to: number;
}

const WORD_BEFORE_CARET = /\S+\s*$/;
const WORD_AFTER_CARET = /^\s*\S+/;

function suggestionMarkType(state: EditorState): ProseMirrorMarkType {
  const markType = state.schema.marks.suggestion;

  if (!markType) throw new Error("suggestion mark is not in the schema");

  return markType;
}

/**
 * True for text the reviewer has proposed adding. Removing such text deletes it
 * outright rather than marking it deleted, because it was never part of the
 * document under review.
 */
function isProposedText(mark: ProseMirrorMark, markType: ProseMirrorMarkType) {
  return (
    mark.type === markType &&
    (mark.attrs.kind === "insert" || mark.attrs.kind === "replace-new")
  );
}

/** True for text a suggestion already proposes removing. */
function isRemovedText(mark: ProseMirrorMark, markType: ProseMirrorMarkType) {
  return (
    mark.type === markType &&
    (mark.attrs.kind === "delete" || mark.attrs.kind === "replace-old")
  );
}

function standingOf(
  node: ProseMirrorNode,
  markType: ProseMirrorMarkType,
): SuggestedTextStanding {
  for (const mark of node.marks) {
    if (isProposedText(mark, markType)) return "proposed";
    if (isRemovedText(mark, markType)) return "removed";
  }

  return "original";
}

/**
 * Split `[from, to)` into runs that share one standing. Every edit in
 * suggesting mode treats the three cases differently, so each one starts here.
 *
 * Inline leaf nodes are content under review like text and carry marks like
 * text, so they are segmented like text: a hard break the reviewer deletes is
 * marked deleted rather than passed over.
 */
export function segmentSuggestedRange(
  state: EditorState,
  from: number,
  to: number,
): SuggestedRangeSegment[] {
  const markType = suggestionMarkType(state);
  const segments: SuggestedRangeSegment[] = [];

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return;

    const segmentFrom = Math.max(pos, from);
    const segmentTo = Math.min(pos + node.nodeSize, to);

    if (segmentFrom >= segmentTo) return;

    const standing = standingOf(node, markType);
    const previous = segments[segments.length - 1];

    if (previous?.standing === standing && previous.to === segmentFrom) {
      previous.to = segmentTo;
      return;
    }

    segments.push({ from: segmentFrom, to: segmentTo, standing });
  });

  return segments;
}

/**
 * The insertion mark abutting `position`, so that consecutive typing stays one
 * suggestion instead of minting an id per keystroke.
 */
function getReusableSuggestionInputMark(
  state: EditorState,
  position: number,
): ProseMirrorMark | null {
  const markType = suggestionMarkType(state);
  const $position = state.doc.resolve(position);
  const isReusable = (mark: ProseMirrorMark) => isProposedText(mark, markType);

  return (
    $position.nodeBefore?.marks.find(isReusable) ??
    $position.nodeAfter?.marks.find(isReusable) ??
    null
  );
}

/**
 * The deletion mark abutting `[from, to)`, so that consecutive removals stay
 * one suggestion.
 */
function getReusableSuggestionDeletionMark(
  state: EditorState,
  from: number,
  to: number,
): ProseMirrorMark | null {
  const markType = suggestionMarkType(state);
  const isReusable = (mark: ProseMirrorMark) =>
    mark.type === markType && mark.attrs.kind === "delete";

  return (
    state.doc.resolve(from).nodeBefore?.marks.find(isReusable) ??
    state.doc.resolve(to).nodeAfter?.marks.find(isReusable) ??
    null
  );
}

/**
 * A block's inline content as text, with the document position each character
 * stands at. Every character is one position wide — a text character by
 * definition, an inline leaf by the one-character text it stands for — so an
 * offset into `text` and the position it names stay in step, which is what
 * turns a word boundary a regular expression found back into a document
 * position. A leaf standing for nothing would run the words on either side of
 * it together and put every position past it out by one.
 */
interface InlineText {
  text: string;
  positions: number[];
}

function readInlineText(
  state: EditorState,
  from: number,
  to: number,
): InlineText {
  let text = "";
  const positions: number[] = [];

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return;

    if (!node.isText) {
      text += INLINE_LEAF_TEXT;
      positions.push(pos);
      return;
    }

    const start = Math.max(pos, from);
    const end = Math.min(pos + node.nodeSize, to);

    text += (node.text ?? "").slice(start - pos, end - pos);

    for (let position = start; position < end; position += 1) {
      positions.push(position);
    }
  });

  return { text, positions };
}

/**
 * The range a Backspace, Delete or Cut consumes. A collapsed caret grows to the
 * character or word on the given side, clamped to its own text block so a word
 * delete cannot reach into the neighbouring paragraph.
 */
export function resolveRemovalRange(
  state: EditorState,
  direction: RemovalDirection,
  granularity: RemovalGranularity,
): DocumentRange {
  const { selection } = state;

  if (!selection.empty) return { from: selection.from, to: selection.to };

  const $caret = state.doc.resolve(selection.from);

  if (direction === "backward") {
    const blockStart = $caret.start($caret.depth);

    if (granularity === "word") {
      const { text, positions } = readInlineText(
        state,
        blockStart,
        selection.from,
      );
      const wordMatch = text.match(WORD_BEFORE_CARET);

      if (wordMatch) {
        return {
          from: positions[text.length - wordMatch[0].length],
          to: selection.to,
        };
      }
    }

    return {
      from: Math.max(blockStart, selection.from - 1),
      to: selection.to,
    };
  }

  const blockEnd = $caret.end($caret.depth);

  if (granularity === "word") {
    const { text, positions } = readInlineText(state, selection.to, blockEnd);
    const wordMatch = text.match(WORD_AFTER_CARET);

    if (wordMatch) {
      // The last matched character is one position wide, so the range ends one
      // past where it starts.
      return {
        from: selection.from,
        to: positions[wordMatch[0].length - 1] + 1,
      };
    }
  }

  return {
    from: selection.from,
    to: Math.min(blockEnd, selection.to + 1),
  };
}

/** True when `ranges` leave no part of `[from, to)` uncovered. */
function coversRange(
  ranges: readonly DocumentRange[],
  from: number,
  to: number,
): boolean {
  let covered = from;

  for (const range of [...ranges].sort(
    (left, right) => left.from - right.from,
  )) {
    if (range.to <= covered) continue;
    if (range.from > covered) return false;

    covered = range.to;
    if (covered >= to) return true;
  }

  return covered >= to;
}

/** The ids of the replacement halves of `kind` that `ranges` cover part of. */
function replacementIdsIn(
  state: EditorState,
  ranges: readonly DocumentRange[],
  kind: SuggestionKind,
  markType: ProseMirrorMarkType,
): Set<string> {
  const suggestionIds = new Set<string>();

  for (const range of ranges) {
    state.doc.nodesBetween(range.from, range.to, (node) => {
      if (!node.isInline) return;

      for (const mark of node.marks) {
        if (mark.type !== markType || mark.attrs.kind !== kind) continue;
        if (typeof mark.attrs.suggestionId !== "string") continue;

        suggestionIds.add(mark.attrs.suggestionId);
      }
    });
  }

  return suggestionIds;
}

/**
 * Keep both halves of every replacement an edit touches in step with each
 * other.
 *
 * A replacement is one suggestion in two halves under one id, written as one
 * `<span>` holding a `<del>` and an `<ins>`. A half left without its partner
 * cannot be written at all: the save keeps its text as ordinary prose and drops
 * the suggestion, so the reviewer's edit is lost. An edit that consumes part of
 * a replacement therefore says what becomes of the rest of it here.
 *
 * @param removed the runs the edit deletes outright
 * @param claimed the runs the edit re-marks as part of a new suggestion
 */
function keepReplacementHalvesInStep(
  state: EditorState,
  tr: Transaction,
  markType: ProseMirrorMarkType,
  removed: readonly DocumentRange[],
  claimed: readonly DocumentRange[],
): void {
  // The edit has taken the old half over, so the replacement it belonged to is
  // superseded: its proposed text goes with it.
  const superseded = replacementIdsIn(state, claimed, "replace-old", markType);

  for (const suggestionId of superseded) {
    for (const range of collectSuggestionRanges(state.doc, suggestionId)) {
      if (range.kind !== "replace-new") continue;

      tr.delete(tr.mapping.map(range.from), tr.mapping.map(range.to));
    }
  }

  // With all of its proposed text gone, what the reviewer is left holding is
  // the deletion of the original text, so that is what the old half becomes.
  for (const suggestionId of replacementIdsIn(
    state,
    removed,
    "replace-new",
    markType,
  )) {
    if (superseded.has(suggestionId)) continue;

    const ranges = collectSuggestionRanges(state.doc, suggestionId);
    const isEmptied = ranges
      .filter((range) => range.kind === "replace-new")
      .every((range) => coversRange(removed, range.from, range.to));

    if (!isEmptied) continue;

    for (const range of ranges) {
      if (range.kind !== "replace-old") continue;

      tr.addMark(
        tr.mapping.map(range.from),
        tr.mapping.map(range.to),
        markType.create({ ...range.mark.attrs, kind: "delete" }),
      );
    }
  }
}

/**
 * Remove proposed insertions outright and mark original text as deleted. Text a
 * suggestion already proposes removing is left as it stands: it is already on
 * its way out, and re-marking it would break the replacement it may be half of.
 *
 * Segments are processed right to left so that positions to the left of the one
 * being edited stay valid.
 */
export function applySuggestedRemoval(
  state: EditorState,
  tr: Transaction,
  segments: readonly SuggestedRangeSegment[],
  createSuggestionAttrs: CreateSuggestionAttrs,
): void {
  const markType = suggestionMarkType(state);

  for (const segment of [...segments].reverse()) {
    if (segment.standing === "removed") continue;

    if (segment.standing === "proposed") {
      tr.delete(segment.from, segment.to);
      continue;
    }

    const deletionMark =
      getReusableSuggestionDeletionMark(state, segment.from, segment.to) ??
      markType.create(createSuggestionAttrs("delete"));

    tr.addMark(segment.from, segment.to, deletionMark);
  }

  keepReplacementHalvesInStep(
    state,
    tr,
    markType,
    segments.filter((segment) => segment.standing === "proposed"),
    [],
  );
}

/**
 * Enter `text` at `[from, to)` as a suggestion.
 *
 * A collapsed caret, or a range holding nothing but proposed insertions, is a
 * plain insertion: the proposed text is dropped and the new text takes its
 * place under one insert mark. A range holding any other text is a replacement,
 * so that text is marked `replace-old` and the new text carries the matching
 * `replace-new` half of the same suggestion.
 */
export function applySuggestedInput(
  state: EditorState,
  tr: Transaction,
  from: number,
  to: number,
  text: string,
  createSuggestionAttrs: CreateSuggestionAttrs,
): void {
  const markType = suggestionMarkType(state);

  if (from === to) {
    insertSuggestedText(state, tr, from, text, markType, createSuggestionAttrs);
    return;
  }

  const segments = segmentSuggestedRange(state, from, to);

  // A range holding no inline content at all — a thematic break or a block
  // image, selected as a node — has nothing a suggestion can be written on:
  // review markup is inline, and there is no inline content here to wrap in an
  // anchor. Replacing the node would take original content out of the document
  // with no record that it ever stood there, so the input is refused and the
  // document stays as it is.
  if (segments.length === 0) return;

  const removed = segments.filter((segment) => segment.standing === "proposed");
  const replaced = segments.filter(
    (segment) => segment.standing !== "proposed",
  );

  if (replaced.length === 0) {
    for (const segment of [...segments].reverse()) {
      tr.delete(segment.from, segment.to);
    }

    keepReplacementHalvesInStep(state, tr, markType, removed, []);

    insertSuggestedText(
      state,
      tr,
      tr.mapping.map(from, -1),
      text,
      markType,
      createSuggestionAttrs,
    );
    return;
  }

  const replacement = createSuggestionAttrs("replace-old");
  const newMark = markType.create({ ...replacement, kind: "replace-new" });

  for (const segment of [...segments].reverse()) {
    if (segment.standing === "proposed") {
      tr.delete(segment.from, segment.to);
    } else {
      tr.addMark(segment.from, segment.to, markType.create(replacement));
    }
  }

  keepReplacementHalvesInStep(state, tr, markType, removed, replaced);

  const insertPos = tr.mapping.map(to, -1);

  tr.insert(insertPos, state.schema.text(text, [newMark]));
  tr.setSelection(TextSelection.create(tr.doc, insertPos + text.length));
}

/**
 * Insert `text` under an insert mark, reusing an adjacent one when there is
 * one.
 *
 * The adjacent mark is looked up in the pre-transaction document on purpose:
 * typing over a whole insertion has just deleted it from `tr.doc`, and reading
 * the document as it stood still finds it, so the replacement text continues
 * that suggestion rather than starting a new one.
 */
function insertSuggestedText(
  state: EditorState,
  tr: Transaction,
  position: number,
  text: string,
  markType: ProseMirrorMarkType,
  createSuggestionAttrs: CreateSuggestionAttrs,
): void {
  const mark =
    getReusableSuggestionInputMark(state, position) ??
    markType.create(createSuggestionAttrs("insert"));

  tr.insert(position, state.schema.text(text, [mark]));
  tr.setSelection(TextSelection.create(tr.doc, position + text.length));
}
