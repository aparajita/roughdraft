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
const REPLACE_ATTRIBUTE = "data-rd-replace";

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
        class: "comment-anchor",
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
        { class: `suggestion suggestion-${kind}` },
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

interface CommentHighlightMeta {
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
}

interface CommentHighlightPluginState extends CommentHighlightMeta {
  decorations: DecorationSet;
}

interface SuggestionHighlightMeta {
  selectedChangeId: string | null;
  hoveredChangeId: string | null;
}

interface SuggestionHighlightPluginState extends SuggestionHighlightMeta {
  decorations: DecorationSet;
}

export const commentHighlightPluginKey =
  new PluginKey<CommentHighlightPluginState>("commentHighlight");
export const suggestionHighlightPluginKey =
  new PluginKey<SuggestionHighlightPluginState>("suggestionHighlight");

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
    const classNames = ["comment-decoration"];

    if (isSelected) {
      classNames.push("comment-decoration-active");
    } else if (isHovered) {
      classNames.push("comment-decoration-hovered");
    }

    if (
      suggestionMarkType &&
      node.marks.some((mark) => mark.type === suggestionMarkType)
    ) {
      classNames.push("comment-decoration-on-suggestion");
    }

    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: classNames.join(" "),
        "data-testid": classNames.includes("comment-decoration-on-suggestion")
          ? "comment-decoration-on-suggestion"
          : "comment-decoration",
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

const CommentHighlight = Extension.create({
  name: "commentHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<CommentHighlightPluginState>({
        key: commentHighlightPluginKey,
        state: {
          init: (_, state) => ({
            selectedCommentId: null,
            hoveredCommentId: null,
            decorations: createCommentHighlightDecorations(
              state.doc,
              null,
              null,
            ),
          }),
          apply: (tr, pluginState) => {
            const meta = tr.getMeta(commentHighlightPluginKey) as
              | CommentHighlightMeta
              | undefined;

            if (!meta && !tr.docChanged) {
              return pluginState;
            }

            const selectedCommentId =
              meta !== undefined
                ? meta.selectedCommentId
                : pluginState.selectedCommentId;
            const hoveredCommentId =
              meta !== undefined
                ? meta.hoveredCommentId
                : pluginState.hoveredCommentId;

            return {
              selectedCommentId,
              hoveredCommentId,
              decorations: createCommentHighlightDecorations(
                tr.doc,
                selectedCommentId,
                hoveredCommentId,
              ),
            };
          },
        },
        props: {
          decorations: (state) =>
            commentHighlightPluginKey.getState(state)?.decorations ?? null,
        },
      }),
    ];
  },
});

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

    const suggestionKind = node.marks.find(
      (mark) =>
        mark.type === suggestionMarkType &&
        typeof mark.attrs.suggestionId === "string" &&
        suggestionIds.includes(mark.attrs.suggestionId) &&
        isSuggestionKind(mark.attrs.kind),
    )?.attrs.kind as SuggestionKind | undefined;
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        "data-testid": isSelected
          ? "suggestion-decoration-active"
          : "suggestion-decoration-hovered",
        class: [
          isSelected
            ? "suggestion-decoration-active"
            : "suggestion-decoration-hovered",
          suggestionKind ? `suggestion-decoration-${suggestionKind}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

const SuggestionHighlight = Extension.create({
  name: "suggestionHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<SuggestionHighlightPluginState>({
        key: suggestionHighlightPluginKey,
        state: {
          init: (_, state) => ({
            selectedChangeId: null,
            hoveredChangeId: null,
            decorations: createSuggestionHighlightDecorations(
              state.doc,
              null,
              null,
            ),
          }),
          apply: (tr, pluginState) => {
            const meta = tr.getMeta(suggestionHighlightPluginKey) as
              | SuggestionHighlightMeta
              | undefined;

            if (!meta && !tr.docChanged) {
              return pluginState;
            }

            const selectedChangeId =
              meta !== undefined
                ? meta.selectedChangeId
                : pluginState.selectedChangeId;
            const hoveredChangeId =
              meta !== undefined
                ? meta.hoveredChangeId
                : pluginState.hoveredChangeId;

            return {
              selectedChangeId,
              hoveredChangeId,
              decorations: createSuggestionHighlightDecorations(
                tr.doc,
                selectedChangeId,
                hoveredChangeId,
              ),
            };
          },
        },
        props: {
          decorations: (state) =>
            suggestionHighlightPluginKey.getState(state)?.decorations ?? null,
        },
      }),
    ];
  },
});

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
