import { RecordIdAllocator } from "@roughdraft/rfm";
import type { JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildLocationForLinkedMarkdownDocument } from "./app-navigation";
import { DocumentReviewRail } from "./DocumentReviewRail";
import {
  buildReviewEntries,
  COMMENT_ANCHOR_SELECTOR,
  DELETION_ANCHOR_SELECTOR,
  EDITOR_REPLACEMENT_ANCHOR_SELECTOR,
  getRootThreadIdForCommentId,
  INSERTION_ANCHOR_SELECTOR,
  REPLACEMENT_ANCHOR_SELECTOR,
  type ReviewEntry,
  readCommentAnchorIds,
  resolveAnchorScroll,
  resolveNextCurrentEntry,
  type SuggestionAnchorItem,
} from "./document-comments";
import { EditorContextMenu } from "./EditorContextMenu";
import {
  commentHighlightPluginKey,
  createEditorExtensions,
  inlineNodeText,
  suggestionHighlightPluginKey,
} from "./editor-extensions";
import { cn } from "./lib/utils";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { EMPTY_ANCHOR_SENTINEL, toHtml } from "./markdown";
import { ReviewEntryFooter } from "./ReviewEntryFooter";
import { ReviewThreadDialog } from "./ReviewThreadDialog";
import {
  createReviewComment,
  createSuggestion,
  editorStateToReviewMarkdown,
  getCommentDescendantIds,
  type ReviewComment,
  reviewMarkdownToEditorState,
  type SuggestionAttrs,
} from "./review";
import {
  findExactCommentAnchorMatch,
  getReviewMarkupBlockedReason,
} from "./review-markup-selection";
import { SuggestionComposerPopover } from "./SuggestionComposerPopover";
import type { Page, StorageBackend } from "./storage";
import {
  applySuggestedInput,
  applySuggestedRemoval,
  type CreateSuggestionAttrs,
  resolveRemovalRange,
  segmentSuggestedRange,
} from "./suggesting-mode";
import { useCommentAnchorLayout } from "./useCommentAnchorLayout";

export type DocumentSaveState = "saved" | "unsaved" | "saving" | "error";

export type ManualSaveResult =
  | { status: "saved" }
  | { status: "blocked" }
  | { status: "error"; error: unknown };

export interface DocumentSaveController {
  flushSave: () => Promise<ManualSaveResult>;
}

type EditorViewMode = "rich-text" | "code";
export type DocumentInteractionMode = "viewing" | "suggesting" | "editing";

interface PageCardProps {
  page: Page;
  activeDocumentPath?: string | null;
  selected?: boolean;
  focusRequestKey?: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange?: (state: DocumentSaveState) => void;
  editorViewMode?: EditorViewMode;
  interactionMode?: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  onReviewFooterVisibleChange?: (visible: boolean) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
}

interface PageCardEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  focusRequestKey: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange: (state: DocumentSaveState) => void;
  editorViewMode: EditorViewMode;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  onReviewFooterVisibleChange?: (visible: boolean) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
}

interface RichTextEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  focusRequestKey: string | null;
  sourceMarkdown: string;
  onMarkdownChange: (markdown: string) => void;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onReviewFooterVisibleChange?: (visible: boolean) => void;
}

interface CodeEditorSurfaceProps {
  markdown: string;
  interactionMode: DocumentInteractionMode;
  onMarkdownChange: (markdown: string) => void;
}

interface DraftSuggestionState {
  type: "insertion" | "replacement";
  from: number;
  to: number;
  sourceText: string;
  text: string;
  /** Where the popover sits: the client rect of the text under change. */
  anchorRect: DOMRect;
}

/**
 * A comment whose id is spoken for but whose record and anchor do not exist
 * yet. Commenting on a selection holds its range here and opens the dialog;
 * nothing reaches the document until a body is submitted.
 */
interface PendingCommentState {
  commentId: string;
  from: number;
  to: number;
  excerpt: string;
}

/** Why the dialog closed itself: the document no longer holds its entry. */
const ENTRY_REMOVED_REASON =
  "This entry is no longer in the document. It was changed outside the editor.";

/** Every comment anchored anywhere in the given range. */
function getRangeCommentIds(editor: Editor, from: number, to: number) {
  const commentIds = new Set<string>();

  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;

    for (const mark of node.marks) {
      if (mark.type.name !== "commentAnchor") continue;

      for (const commentId of mark.attrs.commentIds ?? []) {
        commentIds.add(commentId);
      }
    }
  });

  return [...commentIds];
}

function findCommentRange(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentAnchor;
  if (!commentMarkType) return null;

  let from: number | null = null;
  let to: number | null = null;
  let closed = false;

  editor.state.doc.descendants((node, pos) => {
    // A text node is a leaf of a block, so a block is descended into rather
    // than skipped; only a closed range ends the walk.
    if (closed) return false;
    if (!node.isText) return;

    const hasCommentId = node.marks.some(
      (mark) =>
        mark.type === commentMarkType &&
        Array.isArray(mark.attrs.commentIds) &&
        mark.attrs.commentIds.includes(commentId),
    );

    if (!hasCommentId) {
      if (from != null && to != null && pos >= to) {
        closed = true;
      }
      return;
    }

    if (from == null || to == null) {
      from = pos;
      to = pos + node.nodeSize;
      return;
    }

    if (pos <= to) {
      to = pos + node.nodeSize;
      return;
    }

    closed = true;
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function findCommentAnchorElement(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const anchors = editor.view.dom.querySelectorAll<HTMLElement>(
    COMMENT_ANCHOR_SELECTOR,
  );

  return (
    [...anchors].find((anchor) =>
      readCommentAnchorIds(anchor).includes(commentId),
    ) ?? null
  );
}

function getAnchorCommentIds(
  editor: Editor | null,
  commentId: string,
): string[] {
  const anchorElement = findCommentAnchorElement(editor, commentId);
  if (!anchorElement) return [];
  return readCommentAnchorIds(anchorElement);
}

function addCommentIdsToAnchor(
  editor: Editor | null,
  anchorCommentId: string,
  commentIdsToAdd: string[],
): string[] | null {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentAnchor;
  const anchorCommentIds = getAnchorCommentIds(editor, anchorCommentId);
  const nextCommentIds = [
    ...new Set([...anchorCommentIds, ...commentIdsToAdd]),
  ];
  if (!commentMarkType || anchorCommentIds.length === 0) return null;

  let found = false;
  const tr = editor.state.tr;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const mark = node.marks.find(
      (candidate) =>
        candidate.type === commentMarkType &&
        Array.isArray(candidate.attrs.commentIds) &&
        candidate.attrs.commentIds.includes(anchorCommentId),
    );

    if (!mark) return;

    found = true;

    const from = pos;
    const to = pos + node.nodeSize;
    tr.removeMark(from, to, commentMarkType);
    tr.addMark(
      from,
      to,
      commentMarkType.create({ ...mark.attrs, commentIds: nextCommentIds }),
    );
  });

  if (!found) return null;

  editor.view.dispatch(tr);
  return nextCommentIds;
}

/** Every element in the editor that anchors a suggestion. */
const SUGGESTION_ANCHOR_SELECTOR = [
  INSERTION_ANCHOR_SELECTOR,
  DELETION_ANCHOR_SELECTOR,
  REPLACEMENT_ANCHOR_SELECTOR,
  EDITOR_REPLACEMENT_ANCHOR_SELECTOR,
].join(", ");

function readSuggestionAnchorId(element: HTMLElement): string | null {
  return element.dataset.rdReplace ?? (element.id || null);
}

function getDocumentSuggestionAnchorItems(
  editor: Editor | null,
  comments: ReadonlyMap<string, ReviewComment>,
): SuggestionAnchorItem[] {
  if (!editor) return [];

  const suggestions = new Map<string, SuggestionAnchorItem>();
  const anchors = new Map<
    string,
    {
      anchorTop: number;
      anchorBottom: number;
    }
  >();
  let editorElement: HTMLElement;

  try {
    editorElement = editor.view.dom as HTMLElement;
  } catch {
    return [];
  }

  const suggestionElements = editorElement.querySelectorAll<HTMLElement>(
    SUGGESTION_ANCHOR_SELECTOR,
  );
  const editorRect = editorElement.getBoundingClientRect();

  for (const element of suggestionElements) {
    const suggestionId = readSuggestionAnchorId(element);
    if (!suggestionId) continue;

    const rect = element.getBoundingClientRect();
    const existing = anchors.get(suggestionId);
    const anchorTop = rect.top - editorRect.top;
    const anchorBottom = rect.bottom - editorRect.top;

    if (existing) {
      existing.anchorTop = Math.min(existing.anchorTop, anchorTop);
      existing.anchorBottom = Math.max(existing.anchorBottom, anchorBottom);
    } else {
      anchors.set(suggestionId, {
        anchorTop,
        anchorBottom,
      });
    }
  }

  // A suggestion can cover an inline leaf as well as text — a proposed deletion
  // of a hard break is one — and a suggestion the rail never lists is one the
  // reviewer cannot accept or reject.
  editor.state.doc.descendants((node) => {
    if (!node.isInline) return;

    const suggestionMark = node.marks.find(
      (mark) =>
        mark.type.name === "suggestion" &&
        typeof mark.attrs.suggestionId === "string",
    );
    if (!suggestionMark) return;

    const attrs = suggestionMark.attrs as SuggestionAttrs;
    const suggestionId = attrs.suggestionId;
    const kind = attrs.kind === "replace-new" ? "replace-old" : attrs.kind;
    const existing =
      suggestions.get(suggestionId) ??
      ({
        suggestionId,
        attrs,
        kind,
        oldText: "",
        newText: "",
        commentIds: [],
        anchorTop: anchors.get(suggestionId)?.anchorTop ?? 0,
        anchorBottom: anchors.get(suggestionId)?.anchorBottom ?? 24,
      } satisfies SuggestionAnchorItem);

    existing.attrs = {
      ...attrs,
      kind,
    };
    existing.kind = kind;

    if (attrs.kind === "insert" || attrs.kind === "replace-new") {
      existing.newText += inlineNodeText(node);
    } else {
      existing.oldText += inlineNodeText(node);
    }

    for (const mark of node.marks) {
      if (mark.type.name !== "commentAnchor") continue;
      if (!Array.isArray(mark.attrs.commentIds)) continue;

      existing.commentIds = [
        ...new Set([...existing.commentIds, ...mark.attrs.commentIds]),
      ];
    }

    suggestions.set(suggestionId, existing);
  });

  for (const suggestion of suggestions.values()) {
    const rootCommentIds = [...comments.values()]
      .filter((comment) => comment.parentCommentId === suggestion.suggestionId)
      .map((comment) => comment.id);
    const descendantIds = rootCommentIds.flatMap((commentId) =>
      getCommentDescendantIds(commentId, comments),
    );

    suggestion.commentIds = [
      ...new Set([
        ...suggestion.commentIds,
        ...rootCommentIds,
        ...descendantIds,
      ]),
    ];
  }

  return [...suggestions.values()].sort(
    (left, right) => left.anchorTop - right.anchorTop,
  );
}

function getSuggestionRange(editor: Editor | null, suggestionId: string) {
  if (!editor) return null;

  let from: number | null = null;
  let to: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const hasSuggestion = node.marks.some(
      (mark) =>
        mark.type.name === "suggestion" &&
        mark.attrs.suggestionId === suggestionId,
    );
    if (!hasSuggestion) return;

    from = from == null ? pos : Math.min(from, pos);
    to = to == null ? pos + node.nodeSize : Math.max(to, pos + node.nodeSize);
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function addCommentIdsToSuggestion(
  editor: Editor | null,
  suggestionId: string,
  commentIdsToAdd: string[],
) {
  if (!editor) return false;

  const commentMarkType = editor.state.schema.marks.commentAnchor;
  if (!commentMarkType) return false;

  let found = false;
  const tr = editor.state.tr;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const hasSuggestion = node.marks.some(
      (mark) =>
        mark.type.name === "suggestion" &&
        mark.attrs.suggestionId === suggestionId,
    );
    if (!hasSuggestion) return;

    found = true;
    const existingMark = node.marks.find(
      (mark) => mark.type === commentMarkType,
    );
    const existingCommentIds = Array.isArray(existingMark?.attrs.commentIds)
      ? existingMark.attrs.commentIds
      : [];
    const nextCommentIds = [
      ...new Set([...existingCommentIds, ...commentIdsToAdd]),
    ];
    const from = pos;
    const to = pos + node.nodeSize;

    if (existingMark) {
      tr.removeMark(from, to, commentMarkType);
    }
    tr.addMark(
      from,
      to,
      commentMarkType.create({ commentIds: nextCommentIds }),
    );
  });

  if (!found) return false;

  editor.view.dispatch(tr);
  return true;
}

function findSuggestionAnchorElement(
  editor: Editor | null,
  suggestionId: string,
) {
  if (!editor) return null;

  const anchors = editor.view.dom.querySelectorAll<HTMLElement>(
    SUGGESTION_ANCHOR_SELECTOR,
  );

  return (
    [...anchors].find(
      (anchor) => readSuggestionAnchorId(anchor) === suggestionId,
    ) ?? null
  );
}

/** The element an entry is anchored to, or null when it has no anchor. */
function findEntryAnchorElement(editor: Editor | null, entry: ReviewEntry) {
  switch (entry.kind) {
    case "document-comment":
      return null;
    case "comment-thread":
      return findCommentAnchorElement(editor, entry.id);
    case "suggestion":
      return findSuggestionAnchorElement(editor, entry.id);
  }
}

/**
 * What the anchor scrolls in. The document sits in a scrollable pane rather
 * than scrolling the page itself, so the delta has to be applied to that pane;
 * the window is the fallback for a layout that has no such pane.
 */
function findScrollContainer(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);

    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }

  return null;
}

function scrollAnchorIntoView(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const container = findScrollContainer(anchor);

  if (!container) {
    const delta = resolveAnchorScroll(rect, window.innerHeight);
    if (delta != null) window.scrollBy({ top: delta });
    return;
  }

  const bounds = container.getBoundingClientRect();
  const delta = resolveAnchorScroll(
    { top: rect.top - bounds.top, bottom: rect.bottom - bounds.top },
    container.clientHeight,
  );
  if (delta != null) container.scrollBy({ top: delta });
}

/** A document thread has no anchor, so navigating to it scrolls the document pane to the top instead. */
function scrollDocumentPaneToTop(editor: Editor | null) {
  if (!editor) return;

  const container = findScrollContainer(editor.view.dom);
  if (container) {
    container.scrollTo({ top: 0 });
  } else {
    window.scrollTo({ top: 0 });
  }
}

/** The document text an entry is anchored to, or null when it has no anchor. */
function resolveEntryExcerpt(
  editor: Editor | null,
  entry: ReviewEntry,
): string | null {
  if (!editor || entry.kind === "document-comment") return null;

  const range =
    entry.kind === "comment-thread"
      ? findCommentRange(editor, entry.id)
      : getSuggestionRange(editor, entry.id);
  if (!range) return null;

  return editor.state.doc.textBetween(range.from, range.to, "\n");
}

/** An entry's comments, oldest first: the order the dialog's thread reads in. */
function resolveThreadComments(
  commentIds: string[],
  comments: ReadonlyMap<string, ReviewComment>,
): ReviewComment[] {
  return commentIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is ReviewComment => Boolean(comment))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

/**
 * The review layout grid: a document column and a rail column, both always
 * present so the document does not move as the rail fills. `.review-layout-grid`
 * in `style.css` is the single definition of the grid; `document-page-shell` is
 * a test hook carrying no CSS.
 */
const reviewLayoutGridClass = "review-layout-grid document-page-shell";

/** The document column of the grid, shared by the rich-text and code surfaces. */
const reviewLayoutMainClass =
  "review-layout-main document-page-main w-full min-w-0 max-w-[var(--document-measure)]";

/** The client rect of a document range: what the composer popover points at. */
function getRangeClientRect(editor: Editor, from: number, to: number): DOMRect {
  const start = editor.view.coordsAtPos(from);
  const end = editor.view.coordsAtPos(to);
  const left = Math.min(start.left, end.left);
  const top = Math.min(start.top, end.top);

  return new DOMRect(
    left,
    top,
    Math.max(start.right, end.right) - left,
    Math.max(start.bottom, end.bottom) - top,
  );
}

const RichTextEditorSurface = memo(function RichTextEditorSurface({
  page,
  activeDocumentPath,
  selected,
  focusRequestKey,
  sourceMarkdown,
  onMarkdownChange,
  interactionMode,
  backend,
  onEditorReady,
  onReviewFooterVisibleChange,
}: RichTextEditorSurfaceProps) {
  const editorRef = useRef<Editor | null>(null);
  const suggestionFrameRef = useRef<number | null>(null);
  const interactionModeRef = useRef<DocumentInteractionMode>(interactionMode);
  const commentsRef = useRef<Map<string, ReviewComment>>(new Map());
  const suppressNextMarkdownUpdateRef = useRef(false);
  const lastFocusRequestKeyRef = useRef<string | null>(null);
  /**
   * Exactly one entry is current at a time, and one variable is what makes that
   * true — no rule two setters have to remember.
   */
  const currentEntryIdRef = useRef<string | null>(null);
  const entriesRef = useRef<ReviewEntry[]>([]);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  const [hoveredEntryId, setHoveredEntryId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionAnchorItem[]>([]);
  const [draftSuggestion, setDraftSuggestion] =
    useState<DraftSuggestionState | null>(null);
  const [pendingComment, setPendingComment] =
    useState<PendingCommentState | null>(null);
  const [dialogEntryId, setDialogEntryId] = useState<string | null>(null);
  const [dialogClosedReason, setDialogClosedReason] = useState<string | null>(
    null,
  );

  const resolveFileUrl = useCallback(
    (path: string) => backend.resolveFileUrl(path),
    [backend],
  );
  const resolveLinkUrl = useCallback(
    (path: string) =>
      buildLocationForLinkedMarkdownDocument({
        projectPath: backend.info.projectPath,
        currentDocumentPath: activeDocumentPath,
        href: path,
      }),
    [activeDocumentPath, backend],
  );

  const parsedContent = useMemo(
    () =>
      reviewMarkdownToEditorState(sourceMarkdown, {
        resolveFileUrl,
        resolveLinkUrl,
      }),
    [resolveFileUrl, resolveLinkUrl, sourceMarkdown],
  );
  const [comments, setComments] = useState<Map<string, ReviewComment>>(
    () => parsedContent.comments,
  );
  const frontmatterRef = useRef<string | null>(parsedContent.frontmatter);
  const endmatterRef = useRef<string | null>(parsedContent.endmatter);
  /**
   * Ids for the comments and suggestions made in this editor. The mark only
   * rises, so an id stays spoken for after an undo removes the record carrying
   * it, and after a write from outside replaces the document.
   */
  const idsRef = useRef<RecordIdAllocator>(
    new RecordIdAllocator(parsedContent.document),
  );

  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  const emitMarkdownChange = useCallback(
    (doc?: JSONContent, nextComments?: Map<string, ReviewComment>) => {
      const currentEditor = editorRef.current;
      const currentDoc = doc ?? currentEditor?.getJSON();
      if (!currentDoc) return;

      onMarkdownChange(
        editorStateToReviewMarkdown(
          currentDoc,
          nextComments ?? commentsRef.current,
          {
            frontmatter: frontmatterRef.current,
            endmatter: endmatterRef.current,
          },
        ),
      );
    },
    [onMarkdownChange],
  );

  /** Fresh suggestion attributes, which suggesting-mode edits mint per run. */
  const suggestionAttrs = useCallback<CreateSuggestionAttrs>(
    (kind) => createSuggestion(kind, undefined, { ids: idsRef.current }),
    [],
  );

  const insertFiles = useCallback(
    async (files: File[]) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || files.length === 0) return;

      const assets = await Promise.all(
        files.map((file) => backend.saveAsset(file)),
      );
      const markdown = assets
        .map((asset, index) => {
          const file = files[index];
          if (asset.mimeType.startsWith("image/")) {
            return `![${file?.name || "Image"}](${asset.markdownPath})`;
          }
          return `[${file?.name || "Attachment"}](${asset.markdownPath})`;
        })
        .join("\n\n");

      currentEditor
        .chain()
        .focus()
        .insertContent(
          toHtml(markdown, {
            resolveFileUrl,
            resolveLinkUrl,
          }),
        )
        .run();
    },
    [backend, resolveFileUrl, resolveLinkUrl],
  );

  const refreshSuggestions = useCallback(() => {
    if (suggestionFrameRef.current != null) {
      cancelAnimationFrame(suggestionFrameRef.current);
    }

    suggestionFrameRef.current = requestAnimationFrame(() => {
      suggestionFrameRef.current = null;
      setSuggestions(
        getDocumentSuggestionAnchorItems(
          editorRef.current,
          commentsRef.current,
        ),
      );
    });
  }, []);

  useEffect(() => {
    return () => {
      if (suggestionFrameRef.current != null) {
        cancelAnimationFrame(suggestionFrameRef.current);
      }
    };
  }, []);

  const editor = useEditor(
    {
      extensions: createEditorExtensions("Start writing..."),
      content: parsedContent.doc,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class:
            "tiptap prose prose-stone dark:prose-slate dark:prose-invert max-w-none min-h-[70vh] prose-p:leading-[1.6] prose-h1:font-semibold prose-h2:font-semibold prose-code:before:content-none prose-code:after:content-none prose-blockquote:not-italic [&_blockquote_p:first-of-type]:before:content-none [&_blockquote_p:last-of-type]:after:content-none prose-code:bg-stone-100 dark:prose-code:bg-slate-800 prose-code:rounded prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-a:font-normal prose-hr:p-0 prose-hr:my-3 prose-table:my-1 prose-th:text-base prose-th:pe-2 prose-td:text-base prose-td:ps-0",
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(files);
          return true;
        },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void insertFiles(files);
            return true;
          }

          if (interactionModeRef.current !== "suggesting") return false;

          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          event.preventDefault();

          const { selection } = view.state;
          const tr = view.state.tr;

          applySuggestedInput(
            view.state,
            tr,
            selection.from,
            selection.to,
            text,
            suggestionAttrs,
          );

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleTextInput: (view, from, to, text) => {
          if (interactionModeRef.current !== "suggesting") return false;
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const tr = view.state.tr;

          applySuggestedInput(view.state, tr, from, to, text, suggestionAttrs);

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleKeyDown: (view, event) => {
          if (interactionModeRef.current !== "suggesting") return false;

          if (event.key === "Enter") {
            event.preventDefault();

            const currentEditor = editorRef.current;
            if (!currentEditor) return true;

            const { selection } = view.state;
            if (!selection.empty) return true;

            const $from = selection.$from;
            if (!$from.parent.isTextblock) return true;
            if ($from.parentOffset !== $from.parent.content.size) return true;

            const suggestion = createSuggestion("insert", undefined, {
              ids: idsRef.current,
            });
            const mark = view.state.schema.marks.suggestion.create(suggestion);
            const tr = view.state.tr.split(selection.from);
            const insertPos = tr.selection.from;

            tr.insert(
              insertPos,
              view.state.schema.text(EMPTY_ANCHOR_SENTINEL, [mark]),
            );
            tr.setSelection(
              TextSelection.create(
                tr.doc,
                insertPos + EMPTY_ANCHOR_SENTINEL.length,
              ),
            );
            tr.scrollIntoView();
            view.dispatch(tr);
            return true;
          }

          // Handle Cut (Ctrl+X / Cmd+X)
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "x"
          ) {
            const { selection } = view.state;
            if (selection.empty) return false;

            const currentEditor = editorRef.current;
            if (!currentEditor) return false;

            event.preventDefault();
            const from = selection.from;
            const to = selection.to;
            const selectedText = view.state.doc.textBetween(from, to);
            void navigator.clipboard.writeText(selectedText);

            const tr = view.state.tr;

            applySuggestedRemoval(
              view.state,
              tr,
              segmentSuggestedRange(view.state, from, to),
              suggestionAttrs,
            );

            view.dispatch(tr.scrollIntoView());
            return true;
          }

          if (event.key !== "Backspace" && event.key !== "Delete") return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const isBackspace = event.key === "Backspace";
          const { from, to } = resolveRemovalRange(
            view.state,
            isBackspace ? "backward" : "forward",
            event.ctrlKey || event.altKey ? "word" : "character",
          );

          event.preventDefault();

          if (from === to) return true;

          const tr = view.state.tr;

          const segments = segmentSuggestedRange(view.state, from, to);

          applySuggestedRemoval(view.state, tr, segments, suggestionAttrs);

          // The range holds no inline content — a thematic break or a block
          // image, selected as a node — so the removal was refused, and there
          // is no text position in it to put a caret at either.
          if (segments.length === 0) return true;

          const basePos = isBackspace ? from : to;
          const mappedPos = tr.mapping.map(basePos, -1);
          tr.setSelection(TextSelection.create(tr.doc, mappedPos));
          tr.scrollIntoView();

          view.dispatch(tr);
          return true;
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        if (suppressNextMarkdownUpdateRef.current) {
          suppressNextMarkdownUpdateRef.current = false;
          return;
        }

        emitMarkdownChange(currentEditor.getJSON());
        refreshSuggestions();
      },
    },
    [page.id],
  );

  editorRef.current = editor;
  currentEntryIdRef.current = currentEntryId;

  useEffect(() => {
    editor?.setEditable(interactionMode !== "viewing", false);
  }, [editor, interactionMode]);

  // Viewing mode offers neither the dialog nor a way to create a record, so
  // switching into it takes both away rather than leaving them open behind it.
  useEffect(() => {
    if (interactionMode !== "viewing") return;

    setDialogEntryId(null);
    setDialogClosedReason(null);
    setPendingComment(null);
    setDraftSuggestion(null);
  }, [interactionMode]);

  const { commentGroups, contentHeight, measureLayout } =
    useCommentAnchorLayout(editor, comments.size > 0);

  const entries = useMemo(
    () => buildReviewEntries(commentGroups, suggestions, comments),
    [commentGroups, comments, suggestions],
  );

  entriesRef.current = entries;

  useEffect(() => {
    onEditorReady?.(editor);

    return () => {
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady]);

  /**
   * A non-empty sequence always has a current entry. A pending comment's id
   * survives the frames between its record being written and its anchor being
   * measured, so writing a comment leaves that comment current.
   */
  useEffect(() => {
    setCurrentEntryId((current) => {
      if (current && entries.some((entry) => entry.id === current)) {
        return current;
      }
      if (current && pendingComment?.commentId === current) return current;

      return entries[0]?.id ?? null;
    });
  }, [entries, pendingComment]);

  /**
   * The one way an entry becomes current, so the scroll rule cannot be reached
   * from one path and skipped on another.
   */
  const setCurrentEntry = useCallback((entryId: string) => {
    setCurrentEntryId(entryId);

    const entry = entriesRef.current.find(
      (candidate) => candidate.id === entryId,
    );
    if (!entry) return;

    // The anchor is read after the document has drawn the change that made this
    // entry current — accepting a suggestion moves every anchor below it.
    requestAnimationFrame(() => {
      if (entry.kind === "document-comment") {
        scrollDocumentPaneToTop(editorRef.current);
        return;
      }

      const anchor = findEntryAnchorElement(editorRef.current, entry);
      if (anchor) scrollAnchorIntoView(anchor);
    });
  }, []);

  useEffect(() => {
    if (!editor) return;

    frontmatterRef.current = parsedContent.frontmatter;
    endmatterRef.current = parsedContent.endmatter;
    commentsRef.current = parsedContent.comments;
    idsRef.current.reserve(parsedContent.document);
    setComments(parsedContent.comments);
    setCurrentEntryId(null);
    setHoveredEntryId(null);
    setDraftSuggestion(null);
    setPendingComment(null);

    const nextDoc = parsedContent.doc;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)) {
      editor.commands.setContent(nextDoc, { emitUpdate: false });
    }

    refreshSuggestions();
  }, [editor, parsedContent, refreshSuggestions]);

  useEffect(() => {
    if (!editor || !selected || !focusRequestKey) return;
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;

    requestAnimationFrame(() => {
      editor.chain().focus("end").run();
    });
  }, [editor, focusRequestKey, selected]);

  useEffect(() => {
    commentsRef.current = comments;
    // A suggestion entry carries the comments filed against it, so the read of
    // the document that builds those entries is redone whenever a comment
    // changes.
    refreshSuggestions();
  }, [comments, refreshSuggestions]);

  // Which plugin an entry addresses is decided by what the entry is, not by
  // what its id looks like.
  const entryOf = useCallback(
    (entryId: string | null) =>
      entryId ? (entries.find((entry) => entry.id === entryId) ?? null) : null,
    [entries],
  );
  const currentEntry = entryOf(currentEntryId);
  const hoveredEntry = entryOf(hoveredEntryId);
  const highlightedCommentId =
    currentEntry && currentEntry.kind !== "suggestion" ? currentEntry.id : null;
  const highlightedHoverCommentId =
    hoveredEntry && hoveredEntry.kind !== "suggestion" ? hoveredEntry.id : null;
  const highlightedSuggestionId =
    currentEntry?.kind === "suggestion" ? currentEntry.id : null;
  const highlightedHoverSuggestionId =
    hoveredEntry?.kind === "suggestion" ? hoveredEntry.id : null;

  useEffect(() => {
    if (!editor) return;

    editor.view.dispatch(
      editor.state.tr.setMeta(commentHighlightPluginKey, {
        selectedId: highlightedCommentId,
        hoveredId: highlightedHoverCommentId,
      }),
    );
  }, [editor, highlightedCommentId, highlightedHoverCommentId]);

  useEffect(() => {
    if (!editor) return;

    editor.view.dispatch(
      editor.state.tr.setMeta(suggestionHighlightPluginKey, {
        selectedId: highlightedSuggestionId,
        hoveredId: highlightedHoverSuggestionId,
      }),
    );
  }, [editor, highlightedHoverSuggestionId, highlightedSuggestionId]);

  /**
   * Hovering and clicking an anchor in the document, read from the editor's
   * root rather than from each anchor. ProseMirror replaces the elements it
   * draws as the document changes, so a listener bound to an anchor is lost the
   * moment an edit redraws it, while the root outlives every anchor.
   */
  useEffect(() => {
    if (!editor) return;

    const root = editor.view.dom;

    const entryIdAt = (target: EventTarget | null): string | null => {
      if (!(target instanceof Element)) return null;

      const entryIdOf = (entryId: string | null) =>
        entryId && entriesRef.current.some((entry) => entry.id === entryId)
          ? entryId
          : null;

      // A comment filed against a suggestion belongs to that suggestion's
      // entry, so an anchor inside a suggestion is read as the suggestion.
      const suggestionAnchor = target.closest<HTMLElement>(
        SUGGESTION_ANCHOR_SELECTOR,
      );
      if (suggestionAnchor) {
        return entryIdOf(readSuggestionAnchorId(suggestionAnchor));
      }

      const commentAnchor = target.closest<HTMLElement>(
        COMMENT_ANCHOR_SELECTOR,
      );
      if (!commentAnchor) return null;

      // An anchor names comments; the entry is the thread each belongs to, and
      // an anchor shared by several threads keeps the current one.
      const entryIds = readCommentAnchorIds(commentAnchor)
        .map((commentId) =>
          getRootThreadIdForCommentId(commentId, commentsRef.current),
        )
        .filter((entryId): entryId is string => Boolean(entryId));
      const current = currentEntryIdRef.current;

      return entryIdOf(
        (current && entryIds.includes(current) ? current : entryIds[0]) ?? null,
      );
    };

    const handleMouseOver = (event: MouseEvent) => {
      setHoveredEntryId(entryIdAt(event.target));
    };

    const handleMouseLeave = () => {
      setHoveredEntryId(null);
    };

    const handleClick = (event: MouseEvent) => {
      const entryId = entryIdAt(event.target);
      if (entryId) setCurrentEntry(entryId);
    };

    root.addEventListener("mouseover", handleMouseOver);
    root.addEventListener("mouseleave", handleMouseLeave);
    root.addEventListener("click", handleClick);

    return () => {
      root.removeEventListener("mouseover", handleMouseOver);
      root.removeEventListener("mouseleave", handleMouseLeave);
      root.removeEventListener("click", handleClick);
    };
  }, [editor, setCurrentEntry]);

  /**
   * Runs a document mutation whose Markdown this file emits itself, so the
   * editor's own update does not emit a half-written state.
   */
  const withoutMarkdownEmit = useCallback(<T,>(mutate: () => T): T => {
    suppressNextMarkdownUpdateRef.current = true;
    const result = mutate();
    if (suppressNextMarkdownUpdateRef.current) {
      suppressNextMarkdownUpdateRef.current = false;
    }

    return result;
  }, []);

  const closeDialog = useCallback(() => {
    setDialogEntryId(null);
    setDialogClosedReason(null);
    setPendingComment(null);
  }, []);

  const openDialog = useCallback(
    (entryId: string) => {
      setCurrentEntry(entryId);
      setDialogEntryId(entryId);
      setDialogClosedReason(null);
    },
    [setCurrentEntry],
  );

  /**
   * Commenting writes nothing: it holds the range the comment will be anchored
   * to and opens the dialog on it. The id is spoken for from here so that the
   * dialog, the current entry and the record all name the same comment, but the
   * record and its anchor are written only when a body is submitted.
   */
  const handleAddComment = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;
    // The one test that decides whether commenting is offered decides whether
    // it happens, so the two cannot disagree about which selections are legal.
    if (getReviewMarkupBlockedReason(currentEditor, "comment")) return;

    const { from, to } = currentEditor.state.selection;

    // Collapsing the selection here, rather than leaving it to the dialog's
    // close handler, keeps the anchor range read above intact for both the
    // exact-match reopen and the new-comment path below.
    currentEditor.commands.setTextSelection(to);

    // A selection matching an anchor's range exactly names the same text a
    // comment already sits on: open that thread rather than filing a second,
    // independent thread over identical text.
    const exactAnchor = findExactCommentAnchorMatch(currentEditor, from, to);
    if (exactAnchor) {
      const candidateEntryIds = (
        (exactAnchor.attrs.commentIds ?? []) as string[]
      )
        .map((commentId) =>
          getRootThreadIdForCommentId(commentId, commentsRef.current),
        )
        .filter(
          (entryId): entryId is string =>
            Boolean(entryId) &&
            entriesRef.current.some((entry) => entry.id === entryId),
        );

      if (candidateEntryIds.length > 0) {
        const current = currentEntryIdRef.current;
        openDialog(
          current && candidateEntryIds.includes(current)
            ? current
            : candidateEntryIds[0],
        );
        return;
      }
    }

    const commentId = idsRef.current.allocateCommentId();

    setPendingComment({
      commentId,
      from,
      to,
      excerpt: currentEditor.state.doc.textBetween(from, to, "\n"),
    });
    setCurrentEntryId(commentId);
    setDialogEntryId(commentId);
    setDialogClosedReason(null);
  }, [openDialog]);

  const handleSuggestDeletion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;
    if (getReviewMarkupBlockedReason(currentEditor, "suggestion")) return;

    // Proposing a deletion from the menu is the same act as pressing Backspace
    // in suggesting mode, so it goes through the same code. Stamping a fresh
    // mark over the selection instead would overwrite any suggestion the
    // selection covers, splitting one deletion into two records or destroying
    // an existing suggestion outright.
    const { state } = currentEditor;
    const { from, to } = state.selection;
    const tr = state.tr;

    applySuggestedRemoval(
      state,
      tr,
      segmentSuggestedRange(state, from, to),
      suggestionAttrs,
    );

    currentEditor.view.focus();
    currentEditor.view.dispatch(tr);
    emitMarkdownChange(currentEditor.getJSON());
    refreshSuggestions();
  }, [emitMarkdownChange, refreshSuggestions, suggestionAttrs]);

  const handleSuggestReplacement = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;
    if (getReviewMarkupBlockedReason(currentEditor, "suggestion")) return;

    const { from, to } = currentEditor.state.selection;
    setDraftSuggestion({
      type: "replacement",
      from,
      to,
      sourceText: currentEditor.state.doc.textBetween(from, to, "\n"),
      text: "",
      anchorRect: getRangeClientRect(currentEditor, from, to),
    });
  }, []);

  const applyDraftSuggestion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || !draftSuggestion) return;

    const nextText = draftSuggestion.text;
    if (!nextText) {
      setDraftSuggestion(null);
      return;
    }

    if (draftSuggestion.type === "insertion") {
      const suggestion = createSuggestion("insert", undefined, {
        ids: idsRef.current,
      });

      currentEditor
        .chain()
        .focus()
        .insertContentAt(draftSuggestion.from, {
          type: "text",
          text: nextText,
          marks: [
            {
              type: "suggestion",
              attrs: suggestion,
            },
          ],
        })
        .run();
      setCurrentEntryId(suggestion.suggestionId);
      setDraftSuggestion(null);
      emitMarkdownChange(currentEditor.getJSON());
      refreshSuggestions();
      return;
    }

    const suggestion = createSuggestion("replace-old", undefined, {
      ids: idsRef.current,
    });
    const replacement: SuggestionAttrs = {
      ...suggestion,
      kind: "replace-new",
    };

    currentEditor
      .chain()
      .focus()
      .setTextSelection({ from: draftSuggestion.from, to: draftSuggestion.to })
      .setSuggestion(suggestion)
      .insertContentAt(draftSuggestion.to, {
        type: "text",
        text: nextText,
        marks: [
          {
            type: "suggestion",
            attrs: replacement,
          },
        ],
      })
      .run();
    setCurrentEntryId(suggestion.suggestionId);
    setDraftSuggestion(null);
    emitMarkdownChange(currentEditor.getJSON());
    refreshSuggestions();
  }, [draftSuggestion, emitMarkdownChange, refreshSuggestions]);

  const handleSuggestInsertion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;
    if (getReviewMarkupBlockedReason(currentEditor, "suggestion")) return;

    const { from } = currentEditor.state.selection;
    const before = currentEditor.state.doc.textBetween(
      Math.max(1, from - 24),
      from,
      " ",
    );
    const after = currentEditor.state.doc.textBetween(
      from,
      Math.min(currentEditor.state.doc.content.size, from + 24),
      " ",
    );

    setDraftSuggestion({
      type: "insertion",
      from,
      to: from,
      sourceText: `${before}▮${after}`.trim(),
      text: "",
      anchorRect: getRangeClientRect(currentEditor, from, from),
    });
  }, []);

  const updateComment = useCallback(
    (commentId: string, updater: (comment: ReviewComment) => ReviewComment) => {
      const existingComment = commentsRef.current.get(commentId);
      if (!existingComment) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(commentId, updater(existingComment));
      commentsRef.current = nextComments;
      setComments(nextComments);
      emitMarkdownChange(undefined, nextComments);
    },
    [emitMarkdownChange],
  );

  /** Records a comment and writes the document that now carries its anchor. */
  const commitComment = useCallback(
    (comment: ReviewComment) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshSuggestions();
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [emitMarkdownChange, measureLayout, refreshSuggestions],
  );

  /**
   * The dialog's composer, and the only place a comment record is created.
   *
   * The first submit on a pending comment writes the root and its anchor; every
   * later one is a reply, and a reply parents to the entry's root — the thread
   * root, or the suggestion — so `re` records thread membership rather than
   * conversational nesting.
   */
  const submitThreadComment = useCallback(
    (body: string) => {
      const currentEditor = editorRef.current;
      const trimmedBody = body.trim();
      if (!currentEditor || !trimmedBody) return;

      if (
        pendingComment &&
        !commentsRef.current.has(pendingComment.commentId)
      ) {
        const { commentId, from, to } = pendingComment;
        const comment = createReviewComment(
          { id: commentId, content: trimmedBody },
          { ids: idsRef.current },
        );
        const anchoredCommentIds = getRangeCommentIds(currentEditor, from, to);

        withoutMarkdownEmit(() =>
          currentEditor
            .chain()
            .setTextSelection({ from, to })
            .setCommentAnchor({
              commentIds: [...anchoredCommentIds, comment.id],
            })
            .setTextSelection(to)
            .run(),
        );
        commitComment(comment);
        return;
      }

      // A comment written moments ago is a thread the rail has not measured
      // yet, and a reply to it lands on the same anchor all the same.
      const entry =
        entriesRef.current.find(
          (candidate) => candidate.id === dialogEntryId,
        ) ??
        (dialogEntryId && pendingComment?.commentId === dialogEntryId
          ? ({ kind: "comment-thread", id: dialogEntryId } as const)
          : null);
      if (!entry) return;

      const comment = createReviewComment(
        { content: trimmedBody, parentCommentId: entry.id },
        { ids: idsRef.current },
      );

      // A document comment has no anchor to name it; every other entry's reply
      // joins the anchor its entry is written on.
      if (entry.kind !== "document-comment") {
        const anchored = withoutMarkdownEmit(() =>
          entry.kind === "suggestion"
            ? addCommentIdsToSuggestion(currentEditor, entry.id, [comment.id])
            : addCommentIdsToAnchor(currentEditor, entry.id, [comment.id]) !==
              null,
        );
        if (!anchored) return;
      }

      commitComment(comment);
    },
    [commitComment, dialogEntryId, pendingComment, withoutMarkdownEmit],
  );

  /**
   * Resolution is written by this handler alone: replying to, editing or
   * deleting a comment leaves `status` and `resolved` as they are.
   */
  const toggleResolved = useCallback(
    (rootCommentId: string, nextResolved: boolean) => {
      updateComment(rootCommentId, (current) => ({
        ...current,
        status: nextResolved ? "resolved" : undefined,
        // The interface offers no field for a resolution summary, so it writes
        // none; one a document arrived with survives being resolved again.
        resolved: nextResolved ? current.resolved : undefined,
      }));
    },
    [updateComment],
  );

  const removeSuggestionComments = useCallback(
    (suggestionId: string, currentEditor: Editor) => {
      const directCommentIds = [...commentsRef.current.values()]
        .filter((comment) => comment.parentCommentId === suggestionId)
        .map((comment) => comment.id);
      const commentIdsToDelete = [
        ...directCommentIds,
        ...directCommentIds.flatMap((commentId) =>
          getCommentDescendantIds(commentId, commentsRef.current),
        ),
      ];

      if (commentIdsToDelete.length === 0) return commentsRef.current;

      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();

      commentsRef.current = nextComments;
      setComments(nextComments);
      return nextComments;
    },
    [],
  );

  /**
   * The entry after the one just removed becomes current.
   *
   * The sequence after the removal is the sequence without that entry:
   * accepting or rejecting takes one entry out and shifts the rest up, leaving
   * their order intact, and the rail's measurement of the new anchor positions
   * arrives a frame later.
   */
  const advancePastEntry = useCallback(
    (removedEntryId: string) => {
      const previousEntries = entriesRef.current;
      const nextEntries = previousEntries.filter(
        (entry) => entry.id !== removedEntryId,
      );
      const nextEntryId = resolveNextCurrentEntry(
        previousEntries,
        nextEntries,
        removedEntryId,
      );

      if (!nextEntryId) {
        setCurrentEntryId(null);
        return;
      }

      setCurrentEntry(nextEntryId);
    },
    [setCurrentEntry],
  );

  const applySuggestion = useCallback(
    (suggestionId: string, outcome: "accept" | "reject") => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const chain = currentEditor.chain().focus();
      if (outcome === "accept") {
        chain.acceptSuggestion(suggestionId);
      } else {
        chain.rejectSuggestion(suggestionId);
      }
      chain.run();

      const nextComments = removeSuggestionComments(
        suggestionId,
        currentEditor,
      );
      setHoveredEntryId((current) =>
        current === suggestionId ? null : current,
      );
      closeDialog();
      advancePastEntry(suggestionId);
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshSuggestions();
    },
    [
      advancePastEntry,
      closeDialog,
      emitMarkdownChange,
      refreshSuggestions,
      removeSuggestionComments,
    ],
  );

  const acceptSuggestion = useCallback(
    (suggestionId: string) => {
      applySuggestion(suggestionId, "accept");
    },
    [applySuggestion],
  );

  const rejectSuggestion = useCallback(
    (suggestionId: string) => {
      applySuggestion(suggestionId, "reject");
    },
    [applySuggestion],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const descendantIds = getCommentDescendantIds(
        commentId,
        commentsRef.current,
      );
      const commentIdsToDelete = [commentId, ...descendantIds];
      const deletedIds = new Set(commentIdsToDelete);
      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }
      commentsRef.current = nextComments;
      setComments(nextComments);

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();
      setHoveredEntryId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      // Deleting the entry the dialog is open on closes it, and closes it as
      // the reviewer's own act rather than as a document that changed underfoot.
      if (dialogEntryId && deletedIds.has(dialogEntryId)) {
        closeDialog();
      }
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [closeDialog, dialogEntryId, emitMarkdownChange, measureLayout],
  );

  const goToAdjacentEntry = useCallback(
    (offset: number) => {
      // Navigation is unavailable while the dialog is open.
      if (dialogEntryId || dialogClosedReason) return;

      const index = entries.findIndex((entry) => entry.id === currentEntryId);
      if (index < 0) return;

      // The sequence wraps at both ends.
      const nextIndex =
        (((index + offset) % entries.length) + entries.length) % entries.length;
      const nextEntry = entries[nextIndex];
      if (!nextEntry) return;

      setCurrentEntry(nextEntry.id);
    },
    [
      currentEntryId,
      dialogClosedReason,
      dialogEntryId,
      entries,
      setCurrentEntry,
    ],
  );

  const goToPreviousEntry = useCallback(() => {
    goToAdjacentEntry(-1);
  }, [goToAdjacentEntry]);

  const goToNextEntry = useCallback(() => {
    goToAdjacentEntry(1);
  }, [goToAdjacentEntry]);

  /**
   * The entry the dialog shows for a comment that has no anchor yet: the
   * pending selection before a body is submitted, and the comment just written
   * in the frames before the rail has measured its anchor.
   */
  const pendingCommentEntry = useMemo<ReviewEntry | null>(() => {
    if (!pendingComment) return null;

    const { commentId } = pendingComment;

    return {
      kind: "comment-thread",
      id: commentId,
      commentIds: comments.has(commentId)
        ? [commentId, ...getCommentDescendantIds(commentId, comments)]
        : [],
      anchorGroupKey: commentId,
      anchorTop: 0,
      anchorBottom: 0,
    };
  }, [comments, pendingComment]);

  const dialogEntry = useMemo(() => {
    if (!dialogEntryId) return null;

    return (
      entries.find((entry) => entry.id === dialogEntryId) ??
      (pendingCommentEntry?.id === dialogEntryId ? pendingCommentEntry : null)
    );
  }, [dialogEntryId, entries, pendingCommentEntry]);

  const dialogComments = useMemo(
    () =>
      dialogEntry
        ? resolveThreadComments(dialogEntry.commentIds, comments)
        : [],
    [comments, dialogEntry],
  );

  const dialogExcerpt = dialogEntry
    ? (resolveEntryExcerpt(editor, dialogEntry) ??
      (pendingComment?.commentId === dialogEntry.id
        ? pendingComment.excerpt
        : null))
    : null;

  /**
   * A document reloaded from disk can drop the entry the dialog is open on. Its
   * thread is gone, so the dialog says so rather than showing an empty one.
   */
  useEffect(() => {
    if (!dialogEntryId) return;
    if (entries.some((entry) => entry.id === dialogEntryId)) return;
    if (pendingComment?.commentId === dialogEntryId) return;

    setDialogEntryId(null);
    setPendingComment(null);
    setDialogClosedReason(ENTRY_REMOVED_REASON);
  }, [dialogEntryId, entries, pendingComment]);

  const resolvedEntryIds = useMemo(
    () =>
      new Set(
        entries
          .filter((entry) => comments.get(entry.id)?.status === "resolved")
          .map((entry) => entry.id),
      ),
    [comments, entries],
  );

  const showReview = interactionMode !== "viewing";

  useEffect(() => {
    onReviewFooterVisibleChange?.(showReview);
    return () => onReviewFooterVisibleChange?.(false);
  }, [showReview, onReviewFooterVisibleChange]);

  const contentCardClass = cn(
    "rounded-[0.75rem] border bg-card shadow-lg",
    currentEntry?.kind === "document-comment"
      ? "border-blue-400"
      : "border-border",
  );
  const contentInsetClass = cn(
    "pb-24",
    // The footer is fixed over the document below the rail breakpoint, so the
    // document ends above it rather than behind it.
    showReview && "pb-[var(--review-footer-height)] rail:pb-24",
  );
  const reviewRailClass =
    "review-layout-rail document-comment-rail hidden rail:block";

  return (
    <div
      className="cursor-text bg-transparent"
      data-testid="page-card-rich-text"
    >
      <div
        data-testid="document-page-shell"
        className={cn(
          reviewLayoutGridClass,
          showReview && "review-layout-grid--centered",
        )}
      >
        <div className={reviewLayoutMainClass}>
          <div className={contentInsetClass}>
            <div
              data-testid="document-content-card"
              className={cn(contentCardClass, "px-6 py-5 sm:px-6 sm:py-5")}
            >
              <EditorContextMenu
                editor={editor}
                backend={backend}
                resolveLinkUrl={resolveLinkUrl}
                onAddComment={showReview ? handleAddComment : undefined}
                getBlockedReason={getReviewMarkupBlockedReason}
                onSuggestDeletion={
                  showReview ? handleSuggestDeletion : undefined
                }
                onSuggestReplacement={
                  showReview ? handleSuggestReplacement : undefined
                }
                onSuggestInsertion={
                  showReview ? handleSuggestInsertion : undefined
                }
              >
                <div data-testid="rich-text-editor">
                  <EditorContent editor={editor} />
                </div>
              </EditorContextMenu>
            </div>
          </div>
        </div>
        {showReview ? (
          <DocumentReviewRail
            className={reviewRailClass}
            testId="document-review-rail"
            entries={entries}
            currentEntryId={currentEntryId}
            resolvedEntryIds={resolvedEntryIds}
            contentHeight={contentHeight}
            onSelectEntry={setCurrentEntry}
            onOpenDialog={openDialog}
            onGoToPreviousEntry={goToPreviousEntry}
            onGoToNextEntry={goToNextEntry}
            onDeleteThread={deleteComment}
            onAcceptSuggestion={acceptSuggestion}
            onRejectSuggestion={rejectSuggestion}
          />
        ) : null}
      </div>
      {showReview ? (
        <ReviewEntryFooter
          entries={entries}
          currentEntryId={currentEntryId}
          resolvedEntryIds={resolvedEntryIds}
          onSelectEntry={setCurrentEntry}
          onOpenDialog={openDialog}
          onGoToPreviousEntry={goToPreviousEntry}
          onGoToNextEntry={goToNextEntry}
          onDeleteThread={deleteComment}
          onAcceptSuggestion={acceptSuggestion}
          onRejectSuggestion={rejectSuggestion}
        />
      ) : null}
      {showReview ? (
        <ReviewThreadDialog
          entry={dialogEntry}
          comments={dialogComments}
          excerpt={dialogExcerpt}
          closedReason={dialogClosedReason}
          onClose={closeDialog}
          onSubmitReply={submitThreadComment}
          onUpdateComment={(commentId, nextContent) => {
            updateComment(commentId, (current) => ({
              ...current,
              content: nextContent,
            }));
          }}
          onDeleteComment={deleteComment}
          onDeleteThread={deleteComment}
          onToggleResolved={toggleResolved}
          onAcceptSuggestion={acceptSuggestion}
          onRejectSuggestion={rejectSuggestion}
        />
      ) : null}
      <SuggestionComposerPopover
        draft={draftSuggestion}
        anchorRect={draftSuggestion?.anchorRect ?? null}
        onTextChange={(text) => {
          setDraftSuggestion((current) =>
            current ? { ...current, text } : current,
          );
        }}
        onApply={applyDraftSuggestion}
        onCancel={() => {
          setDraftSuggestion(null);
        }}
      />
    </div>
  );
});

const CodeEditorSurface = memo(function CodeEditorSurface({
  markdown,
  interactionMode,
  onMarkdownChange,
}: CodeEditorSurfaceProps) {
  const contentInsetClass = "pb-24";

  return (
    <div className="cursor-text bg-transparent" data-testid="page-card-code">
      <div data-testid="document-page-shell" className={reviewLayoutGridClass}>
        <div className={reviewLayoutMainClass}>
          <div className={contentInsetClass}>
            <div
              className="min-h-[calc(70vh+4rem)] rounded-[0.75rem] border border-border bg-card py-10 pr-6 pl-5 shadow-lg sm:py-14 sm:pr-10 sm:pl-8"
              data-testid="document-content-card"
            >
              <MarkdownCodeEditor
                testId="markdown-code-editor"
                value={markdown}
                onChange={onMarkdownChange}
                readOnly={interactionMode === "viewing"}
                autoFocus
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

const PageCardEditorSurface = memo(function PageCardEditorSurface({
  page,
  activeDocumentPath,
  selected,
  focusRequestKey,
  onSave,
  onSaveStateChange,
  editorViewMode,
  interactionMode,
  backend,
  onEditorReady,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
  onReviewFooterVisibleChange,
  saveBlocked = false,
  forceResetKey = null,
}: PageCardEditorSurfaceProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSaveRef = useRef<Promise<ManualSaveResult> | null>(null);
  const pendingMarkdownRef = useRef(page.content);
  const recentMarkdownRef = useRef<Set<string>>(new Set());
  const previousEditorViewModeRef = useRef<EditorViewMode>(editorViewMode);
  const lastAcceptedMarkdownRef = useRef(page.content);
  const localDirtyRef = useRef(false);
  const forceResetKeyRef = useRef(forceResetKey);
  const [markdown, setMarkdown] = useState(page.content);
  const [richTextSourceMarkdown, setRichTextSourceMarkdown] = useState(
    page.content,
  );
  const [richTextSourceVersion, setRichTextSourceVersion] = useState(0);

  const reportDirtyState = useCallback(
    (isDirty: boolean) => {
      if (localDirtyRef.current === isDirty) return;
      localDirtyRef.current = isDirty;
      onDirtyStateChange?.(isDirty);
    },
    [onDirtyStateChange],
  );

  const acceptMarkdown = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      lastAcceptedMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      setRichTextSourceMarkdown(nextMarkdown);
      setRichTextSourceVersion((current) => current + 1);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(false);
      onSaveStateChange("saved");
    },
    [onLocalContentChange, onSaveStateChange, reportDirtyState],
  );

  const rememberRecentMarkdown = useCallback((nextMarkdown: string) => {
    recentMarkdownRef.current.add(nextMarkdown);
    if (recentMarkdownRef.current.size > 10) {
      const iterator = recentMarkdownRef.current.values();
      recentMarkdownRef.current.delete(iterator.next().value as string);
    }
  }, []);

  const performSave = useCallback(
    async (nextMarkdown: string): Promise<ManualSaveResult> => {
      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return { status: "blocked" };
      }

      rememberRecentMarkdown(nextMarkdown);
      onSaveStateChange("saving");

      try {
        await onSave(page.id, nextMarkdown);
        lastAcceptedMarkdownRef.current = nextMarkdown;
        reportDirtyState(pendingMarkdownRef.current !== nextMarkdown);
        onSaveStateChange(
          pendingMarkdownRef.current === nextMarkdown ? "saved" : "saving",
        );
        return { status: "saved" };
      } catch (error) {
        console.error("Failed to save page:", error);
        onSaveStateChange("error");
        return { status: "error", error };
      }
    },
    [
      onSave,
      onSaveStateChange,
      page.id,
      rememberRecentMarkdown,
      reportDirtyState,
      saveBlocked,
    ],
  );

  const scheduleSave = useCallback(
    (nextMarkdown: string) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return;
      }

      onSaveStateChange("saving");
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        inFlightSaveRef.current = performSave(nextMarkdown).finally(() => {
          inFlightSaveRef.current = null;
        });
        void inFlightSaveRef.current;
      }, 500);
    },
    [onSaveStateChange, performSave, saveBlocked],
  );

  const flushSave = useCallback(async (): Promise<ManualSaveResult> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const currentMarkdown = pendingMarkdownRef.current;

    if (
      currentMarkdown === lastAcceptedMarkdownRef.current &&
      !inFlightSaveRef.current
    ) {
      onSaveStateChange("saved");
      return { status: "saved" };
    }

    if (inFlightSaveRef.current) {
      await inFlightSaveRef.current;
      if (pendingMarkdownRef.current === lastAcceptedMarkdownRef.current) {
        onSaveStateChange("saved");
        return { status: "saved" };
      }
    }

    return await performSave(pendingMarkdownRef.current);
  }, [onSaveStateChange, performSave]);

  useEffect(() => {
    onSaveControllerChange?.({ flushSave });
    return () => onSaveControllerChange?.(null);
  }, [flushSave, onSaveControllerChange]);

  const handleMarkdownChange = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(nextMarkdown !== lastAcceptedMarkdownRef.current);
      scheduleSave(nextMarkdown);
    },
    [onLocalContentChange, reportDirtyState, scheduleSave],
  );

  useEffect(() => {
    const forceResetChanged = forceResetKeyRef.current !== forceResetKey;
    forceResetKeyRef.current = forceResetKey;

    if (forceResetChanged) {
      recentMarkdownRef.current.delete(page.content);
      acceptMarkdown(page.content);
      return;
    }

    if (recentMarkdownRef.current.has(page.content)) {
      recentMarkdownRef.current.delete(page.content);
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = markdown;
      reportDirtyState(markdown !== page.content);
      return;
    }

    if (localDirtyRef.current && markdown !== page.content) {
      return;
    }

    if (markdown === page.content) {
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = page.content;
      reportDirtyState(false);
      return;
    }

    acceptMarkdown(page.content);
  }, [acceptMarkdown, forceResetKey, markdown, page.content, reportDirtyState]);

  useEffect(() => {
    if (!saveBlocked || !saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    onSaveStateChange(
      pendingMarkdownRef.current === lastAcceptedMarkdownRef.current
        ? "saved"
        : "unsaved",
    );
  }, [onSaveStateChange, saveBlocked]);

  useEffect(() => {
    const previousEditorViewMode = previousEditorViewModeRef.current;
    previousEditorViewModeRef.current = editorViewMode;

    if (previousEditorViewMode !== "code" || editorViewMode !== "rich-text") {
      return;
    }

    setRichTextSourceMarkdown(markdown);
    setRichTextSourceVersion((current) => current + 1);
  }, [editorViewMode, markdown]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (editorViewMode !== "code") return;
    onReviewFooterVisibleChange?.(false);
  }, [editorViewMode, onReviewFooterVisibleChange]);

  if (editorViewMode === "code") {
    return (
      <CodeEditorSurface
        markdown={markdown}
        interactionMode={interactionMode}
        onMarkdownChange={handleMarkdownChange}
      />
    );
  }

  const effectiveRichTextSourceMarkdown =
    !localDirtyRef.current &&
    !recentMarkdownRef.current.has(page.content) &&
    markdown !== page.content
      ? page.content
      : richTextSourceMarkdown;

  return (
    <RichTextEditorSurface
      key={`${page.id}:${richTextSourceVersion}:${effectiveRichTextSourceMarkdown}`}
      page={page}
      activeDocumentPath={activeDocumentPath}
      selected={selected}
      focusRequestKey={focusRequestKey}
      sourceMarkdown={effectiveRichTextSourceMarkdown}
      onMarkdownChange={handleMarkdownChange}
      interactionMode={interactionMode}
      backend={backend}
      onEditorReady={onEditorReady}
      onReviewFooterVisibleChange={onReviewFooterVisibleChange}
    />
  );
});

export function PageCard({
  page,
  activeDocumentPath = null,
  selected = false,
  focusRequestKey = null,
  onSave,
  onSaveStateChange,
  editorViewMode = "rich-text",
  interactionMode = "editing",
  backend,
  onEditorReady,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
  onReviewFooterVisibleChange,
  saveBlocked,
  forceResetKey,
}: PageCardProps) {
  const [saveState, setSaveState] = useState<DocumentSaveState>("saved");

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [onSaveStateChange, saveState]);

  return (
    <div className="w-full">
      <PageCardEditorSurface
        page={page}
        activeDocumentPath={activeDocumentPath}
        selected={selected}
        focusRequestKey={focusRequestKey}
        onSave={onSave}
        onSaveStateChange={setSaveState}
        editorViewMode={editorViewMode}
        interactionMode={interactionMode}
        backend={backend}
        onEditorReady={onEditorReady}
        onDirtyStateChange={onDirtyStateChange}
        onLocalContentChange={onLocalContentChange}
        onSaveControllerChange={onSaveControllerChange}
        onReviewFooterVisibleChange={onReviewFooterVisibleChange}
        saveBlocked={saveBlocked}
        forceResetKey={forceResetKey}
      />
    </div>
  );
}
