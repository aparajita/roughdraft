import { describe, expect, it } from "vitest";
import {
  buildCommentThreadRailItems,
  buildReviewEntries,
  type CommentGroupAnchor,
  getCommentAnchorMeasurements,
  getRootThreadIdForCommentId,
  groupCommentAnchorMeasurements,
  normalizeCommentMeasurement,
  type ReviewEntry,
  resolveAnchoredRailLayouts,
  resolveAnchorScroll,
  resolveCommentRailLayouts,
  resolveCommentThreadRailLayouts,
  resolveNextCurrentEntry,
  type SuggestionAnchorItem,
} from "../src/document-comments";
import type { SuggestionKind } from "../src/editor-extensions";
import type { ReviewComment } from "../src/review";

function createCommentsMap(comments: ReviewComment[]) {
  return new Map(comments.map((comment) => [comment.id, comment]));
}

describe("document comment layout helpers", () => {
  it.each([
    {
      name: "maps a DOM anchor box to a position relative to the editor",
      id: "rd-c1",
      rdNested: undefined,
      rect: { top: 180, bottom: 212 },
      containerTop: 120,
      measurementScale: 1,
      commentIds: ["rd-c1"],
    },
    {
      name: "normalizes anchor positions with a scale factor",
      id: "rd-c2",
      rdNested: undefined,
      rect: { top: 220, bottom: 284 },
      containerTop: 100,
      measurementScale: 2,
      commentIds: ["rd-c2"],
    },
    {
      name: "reads comments nested on the same range from data-rd-nested",
      id: "rd-c3",
      rdNested: JSON.stringify(["rd-c4"]),
      rect: { top: 180, bottom: 212 },
      containerTop: 120,
      measurementScale: 1,
      commentIds: ["rd-c3", "rd-c4"],
    },
  ])(
    "$name",
    ({ id, rdNested, rect, containerTop, measurementScale, commentIds }) => {
      expect(
        getCommentAnchorMeasurements(
          [{ id, dataset: { rdNested }, getBoundingClientRect: () => rect }],
          containerTop,
          measurementScale,
        ),
      ).toEqual([{ commentIds, anchorTop: 60, anchorBottom: 92 }]);
    },
  );

  it("scales a measurement up when the editor is zoomed out", () => {
    expect(normalizeCommentMeasurement(120, 0.5)).toBe(240);
  });

  it("groups multiple DOM spans that belong to the same anchored comments", () => {
    const grouped = groupCommentAnchorMeasurements([
      {
        commentIds: ["cmt-2", "cmt-3"],
        anchorTop: 40,
        anchorBottom: 54,
      },
      {
        commentIds: ["cmt-3", "cmt-2"],
        anchorTop: 58,
        anchorBottom: 74,
      },
      {
        commentIds: ["cmt-4"],
        anchorTop: 140,
        anchorBottom: 156,
      },
    ]);

    expect(grouped).toEqual([
      {
        key: "cmt-2::cmt-3",
        commentIds: ["cmt-2", "cmt-3"],
        anchorTop: 40,
        anchorBottom: 74,
      },
      {
        key: "cmt-4",
        commentIds: ["cmt-4"],
        anchorTop: 140,
        anchorBottom: 156,
      },
    ]);
  });

  it("pushes overlapping cards down the rail while keeping later gaps intact", () => {
    const layouts = resolveCommentRailLayouts(
      [
        {
          key: "cmt-5",
          commentIds: ["cmt-5"],
          anchorTop: 20,
          anchorBottom: 34,
        },
        {
          key: "cmt-6",
          commentIds: ["cmt-6"],
          anchorTop: 48,
          anchorBottom: 62,
        },
        {
          key: "cmt-7",
          commentIds: ["cmt-7"],
          anchorTop: 220,
          anchorBottom: 236,
        },
      ],
      {
        "cmt-5": 100,
        "cmt-6": 90,
        "cmt-7": 80,
      },
      16,
    );

    expect(
      layouts.map(({ key, railTop, railBottom }) => ({
        key,
        railTop,
        railBottom,
      })),
    ).toEqual([
      {
        key: "cmt-5",
        railTop: 20,
        railBottom: 120,
      },
      {
        key: "cmt-6",
        railTop: 136,
        railBottom: 226,
      },
      {
        key: "cmt-7",
        railTop: 242,
        railBottom: 322,
      },
    ]);
  });

  it("expands a shared anchor into one rail item per root thread", () => {
    const comments = createCommentsMap([
      {
        id: "c1",
        content: "First root",
        createdAt: "2026-04-24T00:00:00.000Z",
      },
      {
        id: "c2",
        content: "Second root",
        createdAt: "2026-04-24T00:00:01.000Z",
      },
      {
        id: "c3",
        content: "Reply",
        createdAt: "2026-04-24T00:00:02.000Z",
        parentCommentId: "c2",
      },
    ]);

    const items = buildCommentThreadRailItems(
      [
        {
          key: "c1::c2::c3",
          commentIds: ["c1", "c2", "c3"],
          anchorTop: 200,
          anchorBottom: 214,
        },
      ],
      comments,
    );

    expect(items).toEqual([
      {
        key: "c1",
        anchorGroupKey: "c1::c2::c3",
        rootCommentId: "c1",
        commentIds: ["c1"],
        anchorTop: 200,
        anchorBottom: 214,
      },
      {
        key: "c2",
        anchorGroupKey: "c1::c2::c3",
        rootCommentId: "c2",
        commentIds: ["c2", "c3"],
        anchorTop: 200,
        anchorBottom: 214,
      },
    ]);
  });

  it("aligns the selected secondary root thread to the shared anchor", () => {
    const layouts = resolveCommentThreadRailLayouts(
      [
        {
          key: "c1",
          anchorGroupKey: "shared",
          rootCommentId: "c1",
          commentIds: ["c1"],
          anchorTop: 200,
          anchorBottom: 214,
        },
        {
          key: "c2",
          anchorGroupKey: "shared",
          rootCommentId: "c2",
          commentIds: ["c2"],
          anchorTop: 200,
          anchorBottom: 214,
        },
      ],
      {
        c1: 90,
        c2: 120,
      },
      "c2",
      16,
    );

    expect(
      layouts.map(({ key, railTop, railBottom }) => ({
        key,
        railTop,
        railBottom,
      })),
    ).toEqual([
      {
        key: "c1",
        railTop: 94,
        railBottom: 184,
      },
      {
        key: "c2",
        railTop: 200,
        railBottom: 320,
      },
    ]);
  });

  it("resolves reply selection to the parent root thread", () => {
    const comments = createCommentsMap([
      {
        id: "c1",
        content: "First root",
        createdAt: "2026-04-24T00:00:00.000Z",
      },
      {
        id: "c2",
        content: "Second root",
        createdAt: "2026-04-24T00:00:01.000Z",
      },
      {
        id: "c3",
        content: "Reply",
        createdAt: "2026-04-24T00:00:02.000Z",
        parentCommentId: "c2",
      },
    ]);

    expect(getRootThreadIdForCommentId("c3", comments)).toBe("c2");

    const layouts = resolveCommentThreadRailLayouts(
      buildCommentThreadRailItems(
        [
          {
            key: "c1::c2::c3",
            commentIds: ["c1", "c2", "c3"],
            anchorTop: 200,
            anchorBottom: 214,
          },
        ],
        comments,
      ),
      {
        c1: 90,
        c2: 120,
      },
      getRootThreadIdForCommentId("c3", comments),
      16,
    );

    expect(layouts.find((layout) => layout.key === "c2")?.railTop).toBe(200);
  });

  it("pushes neighboring threads outward from the active thread with the requested gap", () => {
    const layouts = resolveCommentThreadRailLayouts(
      [
        {
          key: "c1",
          anchorGroupKey: "g1",
          rootCommentId: "c1",
          commentIds: ["c1"],
          anchorTop: 120,
          anchorBottom: 134,
        },
        {
          key: "c2",
          anchorGroupKey: "g2",
          rootCommentId: "c2",
          commentIds: ["c2"],
          anchorTop: 180,
          anchorBottom: 194,
        },
        {
          key: "c3",
          anchorGroupKey: "g3",
          rootCommentId: "c3",
          commentIds: ["c3"],
          anchorTop: 220,
          anchorBottom: 234,
        },
      ],
      {
        c1: 70,
        c2: 110,
        c3: 80,
      },
      "c2",
      24,
    );

    expect(
      layouts.map(({ key, railTop, railBottom }) => ({
        key,
        railTop,
        railBottom,
      })),
    ).toEqual([
      {
        key: "c1",
        railTop: 86,
        railBottom: 156,
      },
      {
        key: "c2",
        railTop: 180,
        railBottom: 290,
      },
      {
        key: "c3",
        railTop: 314,
        railBottom: 394,
      },
    ]);
  });

  it("pins any selected rail item to its anchor", () => {
    const layouts = resolveAnchoredRailLayouts(
      [
        {
          key: "comment-1",
          anchorTop: 100,
          anchorBottom: 114,
          type: "comment",
        },
        {
          key: "suggestion-1",
          anchorTop: 140,
          anchorBottom: 154,
          type: "suggestion",
        },
        {
          key: "comment-2",
          anchorTop: 190,
          anchorBottom: 204,
          type: "comment",
        },
      ],
      {
        "comment-1": 90,
        "suggestion-1": 120,
        "comment-2": 70,
      },
      "suggestion-1",
      16,
    );

    expect(
      layouts.map(({ key, railTop, railBottom }) => ({
        key,
        railTop,
        railBottom,
      })),
    ).toEqual([
      {
        key: "comment-1",
        railTop: 34,
        railBottom: 124,
      },
      {
        key: "suggestion-1",
        railTop: 140,
        railBottom: 260,
      },
      {
        key: "comment-2",
        railTop: 276,
        railBottom: 346,
      },
    ]);
  });

  it("keeps active-neighboring threads visible when active alignment would go negative", () => {
    const layouts = resolveCommentThreadRailLayouts(
      [
        {
          key: "c1",
          anchorGroupKey: "shared",
          rootCommentId: "c1",
          commentIds: ["c1"],
          anchorTop: 80,
          anchorBottom: 94,
        },
        {
          key: "c2",
          anchorGroupKey: "shared",
          rootCommentId: "c2",
          commentIds: ["c2"],
          anchorTop: 80,
          anchorBottom: 94,
        },
      ],
      {
        c1: 100,
        c2: 120,
      },
      "c2",
      16,
    );

    expect(
      layouts.map(({ key, railTop, railBottom }) => ({
        key,
        railTop,
        railBottom,
      })),
    ).toEqual([
      {
        key: "c1",
        railTop: 0,
        railBottom: 100,
      },
      {
        key: "c2",
        railTop: 116,
        railBottom: 236,
      },
    ]);
  });
});

/** The height every anchor in these tests occupies, so a top implies a bottom. */
const ANCHOR_HEIGHT = 14;

const SUGGESTION_TIMESTAMP = "2026-08-30T09:00:00.000Z";

function commentAnchorGroup(
  commentIds: string[],
  anchorTop: number,
): CommentGroupAnchor {
  return {
    key: commentIds.join("::"),
    commentIds,
    anchorTop,
    anchorBottom: anchorTop + ANCHOR_HEIGHT,
  };
}

function suggestionAnchor(
  suggestionId: string,
  kind: SuggestionKind,
  anchorTop: number,
  commentIds: string[] = [],
): SuggestionAnchorItem {
  return {
    suggestionId,
    attrs: { kind, suggestionId, createdAt: SUGGESTION_TIMESTAMP },
    kind,
    oldText: "",
    newText: "clear wording",
    commentIds,
    anchorTop,
    anchorBottom: anchorTop + ANCHOR_HEIGHT,
  };
}

function threadEntry(id: string, anchorTop: number): ReviewEntry {
  return {
    kind: "comment-thread",
    id,
    commentIds: [id],
    anchorGroupKey: id,
    anchorTop,
    anchorBottom: anchorTop + ANCHOR_HEIGHT,
  };
}

function suggestionEntry(id: string, anchorTop: number): ReviewEntry {
  return {
    kind: "suggestion",
    id,
    operation: "insert",
    oldText: "",
    newText: "clear wording",
    commentIds: [],
    anchorTop,
    anchorBottom: anchorTop + ANCHOR_HEIGHT,
  };
}

describe("review entry sequence", () => {
  it("puts document comments first by creation time, then anchors interleaved by position", () => {
    // Inserted out of both orders, so a pass-through of the input order fails.
    const comments = createCommentsMap([
      {
        id: "rd-c9",
        content: "Second document note",
        createdAt: "2026-08-30T12:02:00.000Z",
        scope: "document",
      },
      {
        id: "rd-c8",
        content: "First document note",
        createdAt: "2026-08-30T12:01:00.000Z",
        scope: "document",
      },
      {
        id: "rd-c2",
        content: "Lower anchored thread",
        createdAt: "2026-08-30T12:00:00.000Z",
      },
      {
        id: "rd-c1",
        content: "Upper anchored thread",
        createdAt: "2026-08-30T12:03:00.000Z",
      },
    ]);

    const entries = buildReviewEntries(
      [commentAnchorGroup(["rd-c2"], 300), commentAnchorGroup(["rd-c1"], 100)],
      [suggestionAnchor("rd-s1", "insert", 200)],
      comments,
    );

    expect(
      entries.map((entry) => ({ kind: entry.kind, id: entry.id })),
    ).toEqual([
      { kind: "document-comment", id: "rd-c8" },
      { kind: "document-comment", id: "rd-c9" },
      { kind: "comment-thread", id: "rd-c1" },
      { kind: "suggestion", id: "rd-s1" },
      { kind: "comment-thread", id: "rd-c2" },
    ]);
  });

  it("claims a comment filed against a suggestion for that suggestion's entry", () => {
    const comments = createCommentsMap([
      {
        id: "rd-c1",
        content: "Wording is still vague.",
        createdAt: "2026-08-30T12:00:00.000Z",
      },
      {
        id: "rd-c2",
        content: "Tightened it.",
        createdAt: "2026-08-30T12:01:00.000Z",
        parentCommentId: "rd-c1",
      },
      {
        id: "rd-c3",
        content: "Unrelated thread.",
        createdAt: "2026-08-30T12:02:00.000Z",
      },
    ]);

    const entries = buildReviewEntries(
      [commentAnchorGroup(["rd-c1"], 100), commentAnchorGroup(["rd-c3"], 200)],
      [suggestionAnchor("rd-s1", "insert", 100, ["rd-c1"])],
      comments,
    );

    const ids = entries.map((entry) => entry.id);

    expect(ids).toEqual(["rd-s1", "rd-c3"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries[0]).toMatchObject({
      kind: "suggestion",
      commentIds: ["rd-c1", "rd-c2"],
    });
  });

  it.each([
    {
      name: "returns the entry that took the removed one's place",
      previousEntries: [
        threadEntry("rd-c1", 100),
        suggestionEntry("rd-s1", 200),
        threadEntry("rd-c2", 300),
      ],
      nextEntries: [threadEntry("rd-c1", 100), threadEntry("rd-c2", 300)],
      removedEntryId: "rd-s1",
      expected: "rd-c2",
    },
    {
      name: "returns the last entry when the removed one was last",
      previousEntries: [
        threadEntry("rd-c1", 100),
        suggestionEntry("rd-s1", 200),
        threadEntry("rd-c2", 300),
      ],
      nextEntries: [threadEntry("rd-c1", 100), suggestionEntry("rd-s1", 200)],
      removedEntryId: "rd-c2",
      expected: "rd-s1",
    },
    {
      name: "returns null when the sequence empties",
      previousEntries: [suggestionEntry("rd-s1", 200)],
      nextEntries: [],
      removedEntryId: "rd-s1",
      expected: null,
    },
  ])("$name", ({ previousEntries, nextEntries, removedEntryId, expected }) => {
    expect(
      resolveNextCurrentEntry(previousEntries, nextEntries, removedEntryId),
    ).toBe(expected);
  });

  it.each([
    {
      name: "leaves a fully visible anchor where it is",
      anchor: { top: 100, bottom: 400 },
      expected: null,
    },
    {
      name: "pulls an anchor above the viewport into the upper third",
      anchor: { top: -120, bottom: -20 },
      expected: -420,
    },
    {
      name: "pulls an anchor below the viewport into the upper third",
      anchor: { top: 950, bottom: 1010 },
      expected: 650,
    },
    {
      name: "puts the top of an anchor taller than the viewport in the upper third",
      anchor: { top: 20, bottom: 1500 },
      expected: -280,
    },
  ])("$name", ({ anchor, expected }) => {
    const VIEWPORT_HEIGHT = 900;

    expect(resolveAnchorScroll(anchor, VIEWPORT_HEIGHT)).toBe(expected);
  });
});
