import { Extension, Mark, mergeAttributes, Node } from "@tiptap/core";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type {
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import {
  EMPTY_ANCHOR_SENTINEL,
  HEADING_BLANK_AFTER_ATTRIBUTE,
  HEADING_BLANK_BEFORE_ATTRIBUTE,
  rawMarkdownBlockAttribute,
} from "./markdown";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentAnchor: {
      setCommentAnchor: (attributes: { commentIds: string[] }) => ReturnType;
      removeCommentId: (commentId: string) => ReturnType;
      unsetCommentAnchor: () => ReturnType;
    };
    suggestion: {
      setSuggestion: (attributes: SuggestionAttrs) => ReturnType;
      unsetSuggestion: () => ReturnType;
      acceptSuggestion: (suggestionId: string) => ReturnType;
      rejectSuggestion: (suggestionId: string) => ReturnType;
    };
  }
}

/**
 * The mark layer keeps four values because a ProseMirror mark cannot span both
 * halves of a replacement as one range: the old text and the new text are two
 * adjacent ranges paired by id. The format's three-value kind is derived at the
 * rfm boundary.
 */
export type SuggestionKind =
  | "insert"
  | "delete"
  | "replace-old"
  | "replace-new";

export interface SuggestionAttrs {
  kind: SuggestionKind;
  suggestionId: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  createdAt: string;
}

const COMMENT_ID_PATTERN = /^rd-c\d+$/;
const SUGGESTION_ID_PATTERN = /^rd-s\d+$/;

/**
 * A replacement's two halves share one id, and an `id` must be unique in the
 * document, so the halves carry the id here instead. The `<span>` that owns the
 * real `id` is added around the pair when the document is serialized.
 */
export const REPLACE_ATTRIBUTE = "data-rd-replace";

/**
 * A mark type appears at most once per text node, so several comments covering
 * one range are one mark with several ids. The format nests `<span>` anchors
 * instead; `renderHTML` cannot emit nested elements, so it puts the outermost id
 * in `id` and the rest here, and the review module expands them back to nesting.
 */
const NESTED_COMMENT_IDS_ATTRIBUTE = "data-rd-nested";

/**
 * Attributes the mark layer owns, so they are the ones an anchor's own
 * attributes are read around. `class` is presentation `renderHTML` adds, and
 * `id` plus the two `data-rd-*` names carry the mark's own state.
 */
const MARK_OWNED_ATTRIBUTES = new Set([
  "id",
  "class",
  NESTED_COMMENT_IDS_ATTRIBUTE,
  REPLACE_ATTRIBUTE,
]);

/**
 * An anchor's remaining attributes, kept verbatim so a read/write cycle
 * preserves them as the format requires. Without this the mark would carry only
 * ids and every other attribute would be dropped on the way into the editor,
 * where no later step could recover it.
 */
function readOtherAttributes(element: HTMLElement): Record<string, string> {
  const other: Record<string, string> = {};

  for (const { name, value } of [...element.attributes]) {
    if (MARK_OWNED_ATTRIBUTES.has(name)) continue;
    other[name] = value;
  }

  return other;
}

/**
 * Returns null when the element is not a comment anchor, so that both the parse
 * rule and the attribute parser reject it rather than invent ids for it.
 */
function readCommentAnchorIds(element: HTMLElement): string[] | null {
  const outermost = element.getAttribute("id");

  if (outermost === null || !COMMENT_ID_PATTERN.test(outermost)) return null;

  const nested = element.getAttribute(NESTED_COMMENT_IDS_ATTRIBUTE);

  if (nested === null) return [outermost];

  let parsed: unknown;

  try {
    parsed = JSON.parse(nested);
  } catch {
    return null;
  }

  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (id): id is string =>
        typeof id === "string" && COMMENT_ID_PATTERN.test(id),
    )
  ) {
    return null;
  }

  return [outermost, ...parsed];
}

/**
 * How a `code` element nested inside a review mark is painted, as a single
 * literal Tailwind class string. The comment anchor and both suggestion
 * appearances share it: a nested `code` keeps its inline ring but drops its own
 * background, so the mark's colour shows through. It must stay one literal so
 * Tailwind's source scanner sees every class in it.
 */
const NESTED_CODE_MARK_CLASS =
  "[&_code]:bg-transparent [&_code]:inset-ring-1 [&_code]:inset-ring-slate-900/10 dark:[&_code]:inset-ring-slate-200/15";

const CommentAnchor = Mark.create({
  name: "commentAnchor",
  priority: 1100,
  inclusive: false,
  spanning: true,

  addAttributes() {
    return {
      commentIds: {
        default: [],
        parseHTML: (element) => readCommentAnchorIds(element as HTMLElement),
        renderHTML: (attributes) => {
          const commentIds = attributes.commentIds;

          if (!Array.isArray(commentIds) || commentIds.length === 0) return {};

          const [outermost, ...nested] = commentIds as string[];

          return nested.length === 0
            ? { id: outermost }
            : {
                id: outermost,
                [NESTED_COMMENT_IDS_ATTRIBUTE]: JSON.stringify(nested),
              };
        },
      },
      otherAttributes: {
        default: {},
        parseHTML: (element) => readOtherAttributes(element as HTMLElement),
        renderHTML: (attributes) => {
          const other = attributes.otherAttributes;
          return other && typeof other === "object" ? other : {};
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[id]",
        getAttrs: (element) =>
          readCommentAnchorIds(element as HTMLElement) === null ? false : null,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: `comment-anchor text-inherit box-decoration-clone ${NESTED_CODE_MARK_CLASS}`,
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCommentAnchor:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      removeCommentId:
        (commentId) =>
        ({ tr, state, dispatch }) => {
          const markType = state.schema.marks.commentAnchor;

          if (!markType) return false;

          let found = false;

          state.doc.descendants((node, pos) => {
            if (!node.isText) return;

            const mark = node.marks.find(
              (candidate) =>
                candidate.type === markType &&
                Array.isArray(candidate.attrs.commentIds) &&
                candidate.attrs.commentIds.includes(commentId),
            );

            if (!mark) return;

            found = true;

            const from = pos;
            const to = pos + node.nodeSize;
            const nextIds = (mark.attrs.commentIds as string[]).filter(
              (id) => id !== commentId,
            );

            tr.removeMark(from, to, markType);

            if (nextIds.length > 0) {
              // The anchor's own attributes ride on the mark, so the rebuilt
              // mark has to carry them: rebuilding from `commentIds` alone
              // drops every attribute the anchor was written with.
              tr.addMark(
                from,
                to,
                markType.create({ ...mark.attrs, commentIds: nextIds }),
              );
            }
          });

          if (found && dispatch) {
            dispatch(tr);
          }

          return found;
        },
      unsetCommentAnchor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

function isSuggestionKind(value: unknown): value is SuggestionKind {
  return (
    value === "insert" ||
    value === "delete" ||
    value === "replace-old" ||
    value === "replace-new"
  );
}

/**
 * The identity a suggestion anchor carries in the document body. Author and
 * timestamp live in the endmatter, not on the element, so they are not part of
 * what the DOM can be asked for.
 */
interface SuggestionAnchor {
  kind: SuggestionKind;
  suggestionId: string;
}

/**
 * Returns null when the element is not a suggestion anchor, so that both the
 * parse rule and the attribute parsers reject it rather than substitute a
 * plausible kind or id for one the element does not carry.
 */
function readSuggestionAttrs(element: HTMLElement): SuggestionAnchor | null {
  const tag = element.nodeName.toUpperCase();

  if (tag !== "INS" && tag !== "DEL") return null;

  const replaceId = element.getAttribute(REPLACE_ATTRIBUTE);

  if (replaceId !== null) {
    if (!SUGGESTION_ID_PATTERN.test(replaceId)) return null;

    return {
      kind: tag === "DEL" ? "replace-old" : "replace-new",
      suggestionId: replaceId,
    };
  }

  const id = element.getAttribute("id");

  if (id === null || !SUGGESTION_ID_PATTERN.test(id)) return null;

  return {
    kind: tag === "DEL" ? "delete" : "insert",
    suggestionId: id,
  };
}

/**
 * The text an inline leaf node stands for. A hard break is the only inline leaf
 * this schema has, and what it stands for is the line break it renders. It is
 * one character wide, matching the single document position a leaf occupies, so
 * a reader walking inline content keeps text offsets and positions in step.
 */
export const INLINE_LEAF_TEXT = "\n";

/** The text an inline node contributes to the document. */
export function inlineNodeText(node: ProseMirrorNode): string {
  return node.isText ? (node.text ?? "") : INLINE_LEAF_TEXT;
}

/**
 * Every run of inline content one suggestion covers, in document order. Inline
 * leaf nodes carry the mark as text does — a hard break the reviewer proposed
 * deleting is part of the suggestion — so they are collected with it.
 */
export function collectSuggestionRanges(
  doc: ProseMirrorNode,
  suggestionId: string,
) {
  const markType = doc.type.schema.marks.suggestion;
  const ranges: Array<{
    from: number;
    to: number;
    kind: SuggestionKind;
    mark: ProseMirrorMark;
  }> = [];

  if (!markType) return ranges;

  doc.descendants((node, pos) => {
    if (!node.isInline) return;

    const mark = node.marks.find(
      (candidate) =>
        candidate.type === markType &&
        candidate.attrs.suggestionId === suggestionId &&
        isSuggestionKind(candidate.attrs.kind),
    );

    if (!mark) return;

    const kind = mark.attrs.kind as SuggestionKind;
    const previous = ranges[ranges.length - 1];

    if (
      previous &&
      previous.to === pos &&
      previous.kind === kind &&
      previous.mark.eq(mark)
    ) {
      previous.to = pos + node.nodeSize;
      return;
    }

    ranges.push({
      from: pos,
      to: pos + node.nodeSize,
      kind,
      mark,
    });
  });

  return ranges;
}

function findEmptyAnchorSentinels(
  doc: ProseMirrorNode,
  from: number,
  to: number,
) {
  const positions: number[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return;

    let index = node.text.indexOf(EMPTY_ANCHOR_SENTINEL);
    while (index >= 0) {
      positions.push(pos + index);
      index = node.text.indexOf(EMPTY_ANCHOR_SENTINEL, index + 1);
    }
  });

  return positions;
}

function isOnlyTextblockContent(
  doc: ProseMirrorNode,
  from: number,
  to: number,
) {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);

  return (
    $from.sameParent($to) &&
    $from.parent.isTextblock &&
    from === $from.start() &&
    to === $from.end()
  );
}

/**
 * A mark whose kind or id is missing cannot be written as an anchor, and an
 * anchor that loses its id is review data lost on the next save. The mark
 * reaches the DOM only through `setSuggestion`, whose argument is typed, or
 * through a parse rule that already rejected everything invalid, so a failure
 * here is a programming error and says so rather than emitting a wrong anchor.
 */
function requireSuggestionAnchor(attrs: Record<string, unknown>) {
  const { kind, suggestionId } = attrs;

  if (!isSuggestionKind(kind) || typeof suggestionId !== "string") {
    throw new Error(
      `suggestion mark cannot be rendered: kind=${JSON.stringify(
        kind,
      )} suggestionId=${JSON.stringify(suggestionId)}`,
    );
  }

  return { kind, suggestionId };
}

const parseSuggestionAnchor = (element: HTMLElement | string) =>
  readSuggestionAttrs(element as HTMLElement) === null ? false : null;

/**
 * The two appearances a suggestion can have. A replacement's halves look like
 * the single-sided kind they stand for: `replace-new` reads as an insertion and
 * `replace-old` as a deletion.
 */
type SuggestionAppearance = "insert" | "delete";

/**
 * The one place a suggestion kind is mapped to an appearance, so the mark and
 * the decoration cannot disagree about which colors a kind wears. The `switch`
 * has no `default` branch: a kind added to `SuggestionKind` fails to compile
 * here until it is given an appearance.
 */
function suggestionAppearance(kind: SuggestionKind): SuggestionAppearance {
  switch (kind) {
    case "insert":
    case "replace-new":
      return "insert";
    case "delete":
    case "replace-old":
      return "delete";
  }
}

/**
 * The complete resting appearance of a suggestion of `kind`, as a single
 * space-separated Tailwind class string built from literals. This is the only
 * place a
 * suggestion's resting color is decided, and it never encodes hover or
 * selection state — that state belongs to the decoration, which the mark cannot
 * know about. `insert` and `replace-new` share the insert appearance; `delete`
 * and `replace-old` share the delete appearance.
 *
 * Callers pass the result to `Suggestion.renderHTML` and nowhere else: the mark
 * element spans a suggestion's whole run exactly once, so it is the only
 * element that can carry horizontal padding, a border radius, and the `code`
 * styling that applies to a `code` element nested inside the run.
 */
function suggestionMarkClass(kind: SuggestionKind): string {
  switch (suggestionAppearance(kind)) {
    case "insert":
      return `suggestion rounded-sm px-0.5 box-decoration-clone text-emerald-900 dark:text-emerald-300 bg-emerald-50/95 dark:bg-emerald-900/50 underline decoration-emerald-500/75 dark:decoration-emerald-400/60 underline-offset-[0.16em] ${NESTED_CODE_MARK_CLASS}`;
    case "delete":
      return `suggestion rounded-sm px-0.5 box-decoration-clone text-rose-950 dark:text-rose-300 bg-rose-50/95 dark:bg-rose-900/35 line-through decoration-rose-600/75 dark:decoration-rose-400/60 ${NESTED_CODE_MARK_CLASS}`;
  }
}

/**
 * Only the background override that distinguishes `state` from resting, as a
 * single literal Tailwind class string. It never repeats padding, radius, text
 * color, or text decoration: those sit on the ancestor mark element and are
 * already in effect wherever a decoration is painted.
 */
function suggestionDecorationClass(
  kind: SuggestionKind,
  state: "hovered" | "active",
): string {
  switch (suggestionAppearance(kind)) {
    case "insert":
      return state === "hovered"
        ? "rounded-[0.2rem] bg-emerald-100/95 dark:bg-emerald-900/65"
        : "rounded-[0.2rem] bg-emerald-200/95 dark:bg-emerald-900/80";
    case "delete":
      return state === "hovered"
        ? "rounded-[0.2rem] bg-rose-100/95 dark:bg-rose-900/50"
        : "rounded-[0.2rem] bg-rose-200/95 dark:bg-rose-900/65";
  }
}

const Suggestion = Mark.create({
  name: "suggestion",
  priority: 1090,
  inclusive: false,
  spanning: true,

  addAttributes() {
    return {
      // The element's tag and id carry `kind` and `suggestionId`, and only the
      // mark's own `renderHTML` can choose a tag, so neither renders here.
      kind: {
        default: null,
        parseHTML: (element) =>
          readSuggestionAttrs(element as HTMLElement)?.kind ?? null,
        renderHTML: () => ({}),
      },
      suggestionId: {
        default: null,
        parseHTML: (element) =>
          readSuggestionAttrs(element as HTMLElement)?.suggestionId ?? null,
        renderHTML: () => ({}),
      },
      // Author and timestamp belong to the endmatter record, not to the anchor,
      // so they are neither written to nor read from the element.
      authorType: {
        default: "user",
        renderHTML: () => ({}),
      },
      authorId: {
        default: "user",
        renderHTML: () => ({}),
      },
      createdAt: {
        default: null,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: "ins[id]", getAttrs: parseSuggestionAnchor },
      { tag: "del[id]", getAttrs: parseSuggestionAnchor },
      { tag: `ins[${REPLACE_ATTRIBUTE}]`, getAttrs: parseSuggestionAnchor },
      { tag: `del[${REPLACE_ATTRIBUTE}]`, getAttrs: parseSuggestionAnchor },
    ];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const { kind, suggestionId } = requireSuggestionAnchor(mark.attrs);
    const isReplacement = kind === "replace-old" || kind === "replace-new";
    const tag = kind === "insert" || kind === "replace-new" ? "ins" : "del";

    return [
      tag,
      mergeAttributes(
        HTMLAttributes,
        isReplacement
          ? { [REPLACE_ATTRIBUTE]: suggestionId }
          : { id: suggestionId },
        { class: suggestionMarkClass(kind) },
      ),
      0,
    ];
  },

  addCommands() {
    return {
      setSuggestion:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      unsetSuggestion:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
      acceptSuggestion:
        (suggestionId) =>
        ({ state, dispatch }) => {
          const markType = state.schema.marks.suggestion;
          if (!markType) return false;

          const ranges = collectSuggestionRanges(state.doc, suggestionId);
          if (ranges.length === 0) return false;

          const tr = state.tr;

          for (const range of [...ranges].reverse()) {
            if (range.kind === "delete" || range.kind === "replace-old") {
              tr.delete(range.from, range.to);
            } else {
              const sentinelPositions = findEmptyAnchorSentinels(
                state.doc,
                range.from,
                range.to,
              );

              for (const position of [...sentinelPositions].reverse()) {
                tr.delete(position, position + EMPTY_ANCHOR_SENTINEL.length);
              }

              const from = tr.mapping.map(range.from, -1);
              const to = tr.mapping.map(range.to, -1);
              tr.removeMark(from, to, markType);
            }
          }

          if (dispatch) dispatch(tr);
          return true;
        },
      rejectSuggestion:
        (suggestionId) =>
        ({ state, dispatch }) => {
          const markType = state.schema.marks.suggestion;
          if (!markType) return false;

          const ranges = collectSuggestionRanges(state.doc, suggestionId);
          if (ranges.length === 0) return false;

          const tr = state.tr;

          for (const range of [...ranges].reverse()) {
            if (range.kind === "insert" || range.kind === "replace-new") {
              const sentinelPositions = findEmptyAnchorSentinels(
                state.doc,
                range.from,
                range.to,
              );
              if (
                sentinelPositions.length > 0 &&
                isOnlyTextblockContent(state.doc, range.from, range.to)
              ) {
                const $from = state.doc.resolve(range.from);
                tr.delete($from.before(), $from.after());
              } else {
                tr.delete(range.from, range.to);
              }
            } else {
              tr.removeMark(range.from, range.to, markType);
            }
          }

          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

interface HighlightMeta {
  selectedId: string | null;
  hoveredId: string | null;
}

interface HighlightPluginState extends HighlightMeta {
  decorations: DecorationSet;
}

export const commentHighlightPluginKey = new PluginKey<HighlightPluginState>(
  "commentHighlight",
);
export const suggestionHighlightPluginKey = new PluginKey<HighlightPluginState>(
  "suggestionHighlight",
);

/**
 * The plugin scaffolding every highlight extension shares: a `{selectedId,
 * hoveredId, decorations}` state recomputed from `createDecorations` on init,
 * on a matching meta dispatch, and on every doc change. `createDecorations`
 * is the only part that differs between highlight kinds.
 */
function createHighlightExtension(
  name: string,
  pluginKey: PluginKey<HighlightPluginState>,
  createDecorations: (
    doc: ProseMirrorNode,
    selectedId: string | null,
    hoveredId: string | null,
  ) => DecorationSet,
) {
  return Extension.create({
    name,

    addProseMirrorPlugins() {
      return [
        new Plugin<HighlightPluginState>({
          key: pluginKey,
          state: {
            init: (_, state) => ({
              selectedId: null,
              hoveredId: null,
              decorations: createDecorations(state.doc, null, null),
            }),
            apply: (tr, pluginState) => {
              const meta = tr.getMeta(pluginKey) as HighlightMeta | undefined;

              if (!meta && !tr.docChanged) {
                return pluginState;
              }

              const selectedId =
                meta !== undefined ? meta.selectedId : pluginState.selectedId;
              const hoveredId =
                meta !== undefined ? meta.hoveredId : pluginState.hoveredId;

              return {
                selectedId,
                hoveredId,
                decorations: createDecorations(tr.doc, selectedId, hoveredId),
              };
            },
          },
          props: {
            decorations: (state) =>
              pluginKey.getState(state)?.decorations ?? null,
          },
        }),
      ];
    },
  });
}

/**
 * Which background a comment decoration paints. The decoration owns the
 * comment's resting background, unlike a suggestion's: whether a run sits on a
 * suggestion mark is knowable only from the marks on that run, which is what
 * this decoration pass walks.
 */
type CommentDecorationBackground = "resting" | "highlighted" | "on-suggestion";

/**
 * The complete appearance of a comment decoration, as a single space-separated
 * Tailwind class string. Only the background differs between the three cases,
 * so the rest is written once here.
 */
function commentDecorationClass(background: CommentDecorationBackground) {
  const backgroundClasses = {
    resting: "bg-blue-100 dark:bg-blue-400/70",
    highlighted: "bg-blue-400 dark:bg-blue-700",
    "on-suggestion": "bg-transparent dark:bg-transparent",
  }[background];

  return `comment-decoration px-0.5 text-inherit box-decoration-clone ${backgroundClasses} transition-colors duration-[140ms]`;
}

function createCommentHighlightDecorations(
  doc: ProseMirrorNode,
  selectedCommentId: string | null,
  hoveredCommentId: string | null,
) {
  const commentMarkType = doc.type.schema.marks.commentAnchor;
  const suggestionMarkType = doc.type.schema.marks.suggestion;
  const decorations: Decoration[] = [];

  if (!commentMarkType) {
    return DecorationSet.create(doc, decorations);
  }

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!node.isText) return;

    const commentIds = [
      ...new Set(
        node.marks.flatMap((mark: ProseMirrorMark) =>
          mark.type === commentMarkType && Array.isArray(mark.attrs.commentIds)
            ? mark.attrs.commentIds
            : [],
        ),
      ),
    ];

    if (commentIds.length === 0) return;

    const isSelected =
      !!selectedCommentId && commentIds.includes(selectedCommentId);
    const isHovered =
      !!hoveredCommentId && commentIds.includes(hoveredCommentId);
    const isOnSuggestion =
      !!suggestionMarkType &&
      node.marks.some((mark) => mark.type === suggestionMarkType);

    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: commentDecorationClass(
          isOnSuggestion
            ? "on-suggestion"
            : isSelected || isHovered
              ? "highlighted"
              : "resting",
        ),
        "data-testid": isOnSuggestion
          ? "comment-decoration-on-suggestion"
          : "comment-decoration",
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

const CommentHighlight = createHighlightExtension(
  "commentHighlight",
  commentHighlightPluginKey,
  createCommentHighlightDecorations,
);

function createSuggestionHighlightDecorations(
  doc: ProseMirrorNode,
  selectedChangeId: string | null,
  hoveredChangeId: string | null,
) {
  const suggestionMarkType = doc.type.schema.marks.suggestion;
  const decorations: Decoration[] = [];

  if (!suggestionMarkType) {
    return DecorationSet.create(doc, decorations);
  }

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!node.isText) return;

    const suggestionIds = [
      ...new Set(
        node.marks.flatMap((mark: ProseMirrorMark) =>
          mark.type === suggestionMarkType &&
          typeof mark.attrs.suggestionId === "string"
            ? [mark.attrs.suggestionId]
            : [],
        ),
      ),
    ];

    if (suggestionIds.length === 0) return;

    const isSelected =
      !!selectedChangeId && suggestionIds.includes(selectedChangeId);
    const isHovered =
      !!hoveredChangeId && suggestionIds.includes(hoveredChangeId);

    if (!isSelected && !isHovered) return;

    // `suggestionIds` came from this node's own marks, so the mark is there to
    // be found, and `Suggestion.renderHTML` throws on a mark whose kind is
    // missing, so the kind it carries is a `SuggestionKind`.
    const suggestionKind = node.marks.find(
      (mark) =>
        mark.type === suggestionMarkType &&
        typeof mark.attrs.suggestionId === "string" &&
        suggestionIds.includes(mark.attrs.suggestionId),
    )?.attrs.kind as SuggestionKind;

    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        "data-testid": isSelected
          ? "suggestion-decoration-active"
          : "suggestion-decoration-hovered",
        class: suggestionDecorationClass(
          suggestionKind,
          isSelected ? "active" : "hovered",
        ),
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

const SuggestionHighlight = createHighlightExtension(
  "suggestionHighlight",
  suggestionHighlightPluginKey,
  createSuggestionHighlightDecorations,
);

const MarkdownLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute("title"),
        renderHTML: (attributes) =>
          attributes.title ? { title: attributes.title } : {},
      },
      dataMarkdownSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-src"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownSrc
            ? { "data-markdown-src": attributes.dataMarkdownSrc }
            : {},
      },
      dataMarkdownAutolink: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-autolink"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownAutolink
            ? { "data-markdown-autolink": attributes.dataMarkdownAutolink }
            : {},
      },
    };
  },
});

/**
 * Keeps a heading's source blank lines on the node, so a save writes the
 * spacing the document was read with rather than one canonical form. The
 * markdown layer sets the attributes and spends them; nothing here reads them.
 */
const MarkdownHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      blankBefore: {
        default: false,
        parseHTML: (element) =>
          element.hasAttribute(HEADING_BLANK_BEFORE_ATTRIBUTE),
        renderHTML: (attributes) =>
          attributes.blankBefore
            ? { [HEADING_BLANK_BEFORE_ATTRIBUTE]: "true" }
            : {},
      },
      blankAfter: {
        default: false,
        parseHTML: (element) =>
          element.hasAttribute(HEADING_BLANK_AFTER_ATTRIBUTE),
        renderHTML: (attributes) =>
          attributes.blankAfter
            ? { [HEADING_BLANK_AFTER_ATTRIBUTE]: "true" }
            : {},
      },
    };
  },
});

const MarkdownCode = Code.extend({
  excludes: "bold italic strike link",
});

const MarkdownCodeBlock = CodeBlock.extend({
  marks: "commentAnchor suggestion",
});

const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute("title"),
        renderHTML: (attributes) =>
          attributes.title ? { title: attributes.title } : {},
      },
      dataMarkdownSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-src"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownSrc
            ? { "data-markdown-src": attributes.dataMarkdownSrc }
            : {},
      },
    };
  },
});

const RawMarkdownBlock = Node.create({
  name: "rawMarkdownBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      rawMarkdown: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute(rawMarkdownBlockAttribute) ?? "",
        renderHTML: (attributes) => ({
          [rawMarkdownBlockAttribute]: attributes.rawMarkdown ?? "",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${rawMarkdownBlockAttribute}]`, priority: 1000 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)];
  },
});

export function createEditorExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: false,
      code: false,
      codeBlock: false,
      link: false,
    }),
    MarkdownHeading.configure({
      levels: [1, 2, 3],
    }),
    Placeholder.configure({
      placeholder,
    }),
    MarkdownLink.configure({
      autolink: true,
      openOnClick: false,
      linkOnPaste: true,
      // Configuring `HTMLAttributes` replaces the extension's own defaults
      // rather than merging with them, so `target` and `rel` are repeated here
      // to keep the values a rendered link carries today.
      HTMLAttributes: {
        target: "_blank",
        rel: "noopener noreferrer nofollow",
        class:
          "text-sky-700 dark:text-sky-400 underline decoration-sky-500/50 dark:decoration-sky-400/50 underline-offset-4",
      },
    }),
    MarkdownCode,
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    CommentAnchor,
    Suggestion,
    RawMarkdownBlock,
    MarkdownCodeBlock,
    CommentHighlight,
    SuggestionHighlight,
    MarkdownImage.configure({
      allowBase64: true,
      inline: false,
    }),
  ];
}
