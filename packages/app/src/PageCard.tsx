import { RecordIdAllocator } from "@roughdraft/rfm";
import type { JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildLocationForLinkedMarkdownDocument } from "./app-navigation";
import { CommentEditorList } from "./CommentEditorList";
import {
  DocumentReviewRail,
  type SuggestionRailItem,
} from "./DocumentReviewRail";
import {
  COMMENT_ANCHOR_SELECTOR,
  getPreferredCommentId,
  readCommentAnchorIds,
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
import {
  createReviewComment,
  createSuggestion,
  editorStateToReviewMarkdown,
  getCommentDescendantIds,
  getOrderedAnchorComments,
  type ReviewComment,
  reviewMarkdownHasReviewRail,
  reviewMarkdownToEditorState,
  type SuggestionAttrs,
} from "./review";
import { getReviewMarkupBlockedReason } from "./review-markup-selection";
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
  layout?: "default" | "embedded-demo";
  focusRequestKey?: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange?: (state: DocumentSaveState) => void;
  editorViewMode?: EditorViewMode;
  interactionMode?: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
}

interface PageCardEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange: (state: DocumentSaveState) => void;
  editorViewMode: EditorViewMode;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
}

interface RichTextEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  sourceMarkdown: string;
  onMarkdownChange: (markdown: string) => void;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
}

interface CodeEditorSurfaceProps {
  markdown: string;
  hasCommentRailSpace: boolean;
  interactionMode: DocumentInteractionMode;
  layout: "default" | "embedded-demo";
  onMarkdownChange: (markdown: string) => void;
}

export interface DraftSuggestionState {
  type: "insertion" | "replacement";
  from: number;
  to: number;
  sourceText: string;
  text: string;
}

function areCommentIdListsEqual(
  current: string[] | null | undefined,
  next: string[] | null | undefined,
) {
  if (!current || !next) return current === next;
  if (current.length !== next.length) return false;
  return current.every((commentId, index) => commentId === next[index]);
}

function getSelectionCommentIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directAttributes = editor.getAttributes("commentAnchor").commentIds;

  if (Array.isArray(directAttributes) && directAttributes.length > 0) {
    return directAttributes;
  }

  const { from, to, empty, $from } = editor.state.selection;
  const commentIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "commentAnchor") continue;

      for (const commentId of mark.attrs.commentIds ?? []) {
        commentIds.add(commentId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "commentAnchor") continue;

        for (const commentId of mark.attrs.commentIds ?? []) {
          commentIds.add(commentId);
        }
      }
    });
  }

  return [...commentIds];
}

function getSelectionSuggestionIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directSuggestionId = editor.getAttributes("suggestion").suggestionId;

  if (typeof directSuggestionId === "string" && directSuggestionId.length > 0) {
    return [directSuggestionId];
  }

  const { from, to, empty, $from } = editor.state.selection;
  const suggestionIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "suggestion") continue;
      if (typeof mark.attrs.suggestionId === "string") {
        suggestionIds.add(mark.attrs.suggestionId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "suggestion") continue;
        if (typeof mark.attrs.suggestionId === "string") {
          suggestionIds.add(mark.attrs.suggestionId);
        }
      }
    });
  }

  return [...suggestionIds];
}

function getPreferredSuggestionId(
  suggestionIds: string[],
  currentSuggestionId: string | null,
): string | null {
  if (currentSuggestionId && suggestionIds.includes(currentSuggestionId)) {
    return currentSuggestionId;
  }

  return suggestionIds[0] ?? null;
}

function findCommentRange(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentAnchor;
  if (!commentMarkType) return null;

  let from: number | null = null;
  let to: number | null = null;
  let closed = false;

  editor.state.doc.descendants((node, pos) => {
    if (closed || !node.isText) return false;

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

/**
 * A suggestion in the rendered document is an `<ins>` or `<del>` carrying the
 * suggestion id as its element id, or one half of a replacement pair, which
 * carries the shared id in `data-rd-replace` because an id must be unique.
 */
const SUGGESTION_ANCHOR_SELECTOR =
  'ins[id^="rd-s"], del[id^="rd-s"], [data-rd-replace]';

function readSuggestionAnchorId(element: HTMLElement): string | null {
  return element.dataset.rdReplace ?? (element.id || null);
}

function getDocumentSuggestionRailItems(
  editor: Editor | null,
  comments: ReadonlyMap<string, ReviewComment>,
): SuggestionRailItem[] {
  if (!editor) return [];

  const suggestions = new Map<string, SuggestionRailItem>();
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
      } satisfies SuggestionRailItem);

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

export function shouldDismissCommentThread(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;

  return !target.closest(
    `[data-comment-thread-container="true"], [data-suggestion-thread-container="true"], ${COMMENT_ANCHOR_SELECTOR}, ${SUGGESTION_ANCHOR_SELECTOR}`,
  );
}

const RichTextEditorSurface = memo(function RichTextEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  sourceMarkdown,
  onMarkdownChange,
  interactionMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
}: RichTextEditorSurfaceProps) {
  const editorRef = useRef<Editor | null>(null);
  const suggestionFrameRef = useRef<number | null>(null);
  const interactionModeRef = useRef<DocumentInteractionMode>(interactionMode);
  const commentsRef = useRef<Map<string, ReviewComment>>(new Map());
  const suppressNextMarkdownUpdateRef = useRef(false);
  const lastFocusRequestKeyRef = useRef<string | null>(null);
  const selectedCommentIdRef = useRef<string | null>(null);
  const selectedChangeIdRef = useRef<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null,
  );
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [hoveredChangeId, setHoveredChangeId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionRailItem[]>([]);
  const [draftSuggestion, setDraftSuggestion] =
    useState<DraftSuggestionState | null>(null);
  const [pendingFocusCommentId, setPendingFocusCommentId] = useState<
    string | null
  >(null);

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
    commentsRef.current = comments;
  }, [comments]);

  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  useEffect(() => {
    onCommentRailPresenceChange?.(comments.size > 0 || suggestions.length > 0);
  }, [comments.size, suggestions.length, onCommentRailPresenceChange]);

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
        getDocumentSuggestionRailItems(editorRef.current, commentsRef.current),
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
          class: "tiptap min-h-[70vh]",
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
  selectedCommentIdRef.current = selectedCommentId;
  selectedChangeIdRef.current = selectedChangeId;

  useEffect(() => {
    editor?.setEditable(interactionMode !== "viewing", false);
  }, [editor, interactionMode]);

  const activeCommentIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCommentIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];
  const activeChangeIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionSuggestionIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];

  const { commentGroups, contentHeight, measureLayout } =
    useCommentAnchorLayout(editor, comments.size > 0);

  useEffect(() => {
    onEditorReady?.(editor);

    return () => {
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady]);

  useEffect(() => {
    setSelectedCommentId((current) =>
      getPreferredCommentId(activeCommentIds, current),
    );
  }, [activeCommentIds]);

  useEffect(() => {
    setSelectedChangeId((current) =>
      getPreferredSuggestionId(activeChangeIds, current),
    );
  }, [activeChangeIds]);

  useEffect(() => {
    if (!editor) return;

    frontmatterRef.current = parsedContent.frontmatter;
    endmatterRef.current = parsedContent.endmatter;
    commentsRef.current = parsedContent.comments;
    idsRef.current.reserve(parsedContent.document);
    setComments(parsedContent.comments);
    setSelectedCommentId(null);
    setHoveredCommentId(null);
    setSelectedChangeId(null);
    setHoveredChangeId(null);
    setDraftSuggestion(null);
    setPendingFocusCommentId(null);

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
    if (selectedCommentId && !comments.has(selectedCommentId)) {
      setSelectedCommentId(null);
    }

    if (hoveredCommentId && !comments.has(hoveredCommentId)) {
      setHoveredCommentId(null);
    }
    refreshSuggestions();
  }, [comments, hoveredCommentId, refreshSuggestions, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredCommentId = selectedCommentId
      ? hoveredCommentId
      : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(commentHighlightPluginKey, {
        selectedCommentId,
        hoveredCommentId: effectiveHoveredCommentId,
      }),
    );
  }, [editor, hoveredCommentId, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredChangeId = selectedChangeId ? hoveredChangeId : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(suggestionHighlightPluginKey, {
        selectedChangeId,
        hoveredChangeId: effectiveHoveredChangeId,
      }),
    );
  }, [editor, hoveredChangeId, selectedChangeId]);

  useEffect(() => {
    if (!editor) return;

    const anchorElements = editor.view.dom.querySelectorAll<HTMLElement>(
      COMMENT_ANCHOR_SELECTOR,
    );
    const cleanupCallbacks: Array<() => void> = [];

    for (const anchor of anchorElements) {
      const commentIds = readCommentAnchorIds(anchor);
      if (commentIds.length === 0) continue;

      const handleMouseEnter = () => {
        const nextCommentId = getPreferredCommentId(
          commentIds,
          selectedCommentIdRef.current,
        );
        if (nextCommentId) {
          setHoveredCommentId(nextCommentId);
        }
      };

      const handleMouseLeave = () => {
        setHoveredCommentId((current) =>
          current && commentIds.includes(current) ? null : current,
        );
      };

      const handleClick = () => {
        const nextCommentId = getPreferredCommentId(
          commentIds,
          selectedCommentIdRef.current,
        );
        if (nextCommentId) {
          setSelectedCommentId(nextCommentId);
        }
      };

      anchor.addEventListener("mouseenter", handleMouseEnter);
      anchor.addEventListener("mouseleave", handleMouseLeave);
      anchor.addEventListener("click", handleClick);
      cleanupCallbacks.push(() => {
        anchor.removeEventListener("mouseenter", handleMouseEnter);
        anchor.removeEventListener("mouseleave", handleMouseLeave);
        anchor.removeEventListener("click", handleClick);
      });
    }

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;

    const suggestionElements = editor.view.dom.querySelectorAll<HTMLElement>(
      SUGGESTION_ANCHOR_SELECTOR,
    );
    const cleanupCallbacks: Array<() => void> = [];

    for (const element of suggestionElements) {
      const suggestionId = readSuggestionAnchorId(element);
      if (!suggestionId) continue;

      const handleMouseEnter = () => {
        setHoveredChangeId(suggestionId);
      };

      const handleMouseLeave = () => {
        setHoveredChangeId((current) =>
          current === suggestionId ? null : current,
        );
      };

      const handleClick = () => {
        setSelectedChangeId(suggestionId);
      };

      element.addEventListener("mouseenter", handleMouseEnter);
      element.addEventListener("mouseleave", handleMouseLeave);
      element.addEventListener("click", handleClick);
      cleanupCallbacks.push(() => {
        element.removeEventListener("mouseenter", handleMouseEnter);
        element.removeEventListener("mouseleave", handleMouseLeave);
        element.removeEventListener("click", handleClick);
      });
    }

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [editor]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!selectedCommentIdRef.current && !selectedChangeIdRef.current) return;
      if (!shouldDismissCommentThread(event.target)) return;

      setSelectedCommentId(null);
      setHoveredCommentId(null);
      setSelectedChangeId(null);
      setHoveredChangeId(null);
      setPendingFocusCommentId(null);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
    };
  }, []);

  const handleAddComment = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;
    // The one test that decides whether commenting is offered decides whether
    // it happens, so the two cannot disagree about which selections are legal.
    if (getReviewMarkupBlockedReason(currentEditor, "comment")) return;

    const existingIds = getSelectionCommentIds(currentEditor);
    const comment = createReviewComment(undefined, {
      ids: idsRef.current,
    });
    const nextComments = new Map(commentsRef.current);
    nextComments.set(comment.id, comment);
    commentsRef.current = nextComments;
    setComments(nextComments);

    suppressNextMarkdownUpdateRef.current = true;
    currentEditor
      .chain()
      .focus()
      .setCommentAnchor({ commentIds: [...existingIds, comment.id] })
      .run();
    if (suppressNextMarkdownUpdateRef.current) {
      suppressNextMarkdownUpdateRef.current = false;
    }

    setSelectedCommentId(comment.id);
    setPendingFocusCommentId(comment.id);
    requestAnimationFrame(() => {
      measureLayout();
    });
  }, [measureLayout]);

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
      setSelectedChangeId(suggestion.suggestionId);
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
    setSelectedChangeId(suggestion.suggestionId);
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

  const replyToComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const comment = createReviewComment(
        {
          parentCommentId: commentId,
        },
        {
          ids: idsRef.current,
        },
      );
      suppressNextMarkdownUpdateRef.current = true;
      const nextAnchorCommentIds = addCommentIdsToAnchor(
        currentEditor,
        commentId,
        [comment.id],
      );
      if (suppressNextMarkdownUpdateRef.current) {
        suppressNextMarkdownUpdateRef.current = false;
      }
      if (!nextAnchorCommentIds) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [measureLayout],
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

  const acceptSuggestion = useCallback(
    (suggestionId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().acceptSuggestion(suggestionId).run();
      const nextComments = removeSuggestionComments(
        suggestionId,
        currentEditor,
      );
      setSelectedChangeId((current) =>
        current === suggestionId ? null : current,
      );
      setHoveredChangeId((current) =>
        current === suggestionId ? null : current,
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshSuggestions();
    },
    [emitMarkdownChange, refreshSuggestions, removeSuggestionComments],
  );

  const rejectSuggestion = useCallback(
    (suggestionId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().rejectSuggestion(suggestionId).run();
      const nextComments = removeSuggestionComments(
        suggestionId,
        currentEditor,
      );
      setSelectedChangeId((current) =>
        current === suggestionId ? null : current,
      );
      setHoveredChangeId((current) =>
        current === suggestionId ? null : current,
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshSuggestions();
    },
    [emitMarkdownChange, refreshSuggestions, removeSuggestionComments],
  );

  const replyToSuggestion = useCallback(
    (suggestionId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const comment = createReviewComment(
        {
          parentCommentId: suggestionId,
        },
        {
          ids: idsRef.current,
        },
      );
      suppressNextMarkdownUpdateRef.current = true;
      const didAddCommentId = addCommentIdsToSuggestion(
        currentEditor,
        suggestionId,
        [comment.id],
      );
      if (suppressNextMarkdownUpdateRef.current) {
        suppressNextMarkdownUpdateRef.current = false;
      }
      if (!didAddCommentId) {
        return;
      }

      const nextComments = new Map(commentsRef.current);
      nextComments.set(comment.id, comment);
      commentsRef.current = nextComments;
      setComments(nextComments);
      setSelectedChangeId(suggestionId);
      setSelectedCommentId(comment.id);
      setHoveredCommentId(null);
      setPendingFocusCommentId(comment.id);
      refreshSuggestions();
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [measureLayout, refreshSuggestions],
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
      setSelectedCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setHoveredCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setPendingFocusCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [emitMarkdownChange, measureLayout],
  );

  const selectComment = useCallback((commentId: string) => {
    setSelectedCommentId(commentId);
  }, []);

  const selectSuggestion = useCallback((suggestionId: string) => {
    setSelectedChangeId(suggestionId);
    setSelectedCommentId(null);
  }, []);

  const focusComment = useCallback((commentId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedCommentId(commentId);

    const range = findCommentRange(currentEditor, commentId);
    if (range) {
      currentEditor.commands.focus(undefined, { scrollIntoView: false });
      currentEditor.view.dispatch(
        currentEditor.state.tr.setSelection(
          TextSelection.create(currentEditor.state.doc, range.from, range.to),
        ),
      );
      return;
    }

    if (!findCommentAnchorElement(currentEditor, commentId)) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
  }, []);

  const focusSuggestion = useCallback((suggestionId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedChangeId(suggestionId);
    setSelectedCommentId(null);

    const range = getSuggestionRange(currentEditor, suggestionId);
    if (!range) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
    currentEditor.view.dispatch(
      currentEditor.state.tr.setSelection(
        TextSelection.create(currentEditor.state.doc, range.from, range.to),
      ),
    );
  }, []);

  const hasReviewRail = comments.size > 0 || suggestions.length > 0;
  const activeComments = getOrderedAnchorComments(activeCommentIds, comments);
  const contentCardClass =
    "rounded-[0.75rem] border border-[#E9E9E8] dark:border-border bg-white dark:bg-card shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)]";
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "flex flex-col gap-6 min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,60rem)_minmax(24rem,1fr)] min-[1100px]:items-start min-[1100px]:justify-between min-[1100px]:gap-8",
    !hasReviewRail && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasReviewRail &&
      "min-[1100px]:grid-cols-[minmax(0,60rem)] min-[1100px]:justify-center",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo" ? "max-w-none" : "max-w-[60rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const fallbackClass = cn(
    "document-comment-fallback mb-4",
    layout === "embedded-demo" ? "hidden" : "min-[1100px]:hidden",
  );
  const reviewRailClass = cn(
    "document-comment-rail",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : "hidden min-[1100px]:block",
  );

  return (
    <div
      className="cursor-text bg-transparent"
      data-testid="page-card-rich-text"
    >
      <div data-testid="document-page-shell" className={documentShellClass}>
        <div className={documentMainClass}>
          {activeComments.length > 0 ? (
            <CommentEditorList
              comments={activeComments}
              className={fallbackClass}
              testId="document-comment-fallback"
              selectedCommentId={selectedCommentId}
              hoveredCommentId={hoveredCommentId}
              onDeleteComment={deleteComment}
              onUpdateComment={(commentId, nextContent) => {
                updateComment(commentId, (current) => ({
                  ...current,
                  content: nextContent,
                }));
              }}
              onReplyComment={replyToComment}
              onSelectComment={selectComment}
              onHoverComment={setHoveredCommentId}
              pendingFocusCommentId={pendingFocusCommentId}
              onAutoFocusComment={(commentId) => {
                setPendingFocusCommentId((current) =>
                  current === commentId ? null : current,
                );
              }}
            />
          ) : null}
          <div className={contentInsetClass}>
            <div
              data-testid="document-content-card"
              className={cn(contentCardClass, "px-10 py-10 sm:px-14 sm:py-14")}
            >
              <EditorContextMenu
                editor={editor}
                backend={backend}
                resolveLinkUrl={resolveLinkUrl}
                onAddComment={
                  interactionMode === "viewing" ? undefined : handleAddComment
                }
                getBlockedReason={getReviewMarkupBlockedReason}
                onSuggestDeletion={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestDeletion
                }
                onSuggestReplacement={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestReplacement
                }
                onSuggestInsertion={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestInsertion
                }
              >
                <div data-testid="rich-text-editor">
                  <EditorContent editor={editor} />
                </div>
              </EditorContextMenu>
            </div>
          </div>
        </div>
        <DocumentReviewRail
          className={reviewRailClass}
          layout={layout === "embedded-demo" ? "flow" : "anchored"}
          testId="document-review-rail"
          commentGroups={commentGroups}
          comments={comments}
          suggestions={suggestions}
          selectedCommentId={selectedCommentId}
          hoveredCommentId={hoveredCommentId}
          selectedChangeId={selectedChangeId}
          hoveredChangeId={hoveredChangeId}
          contentHeight={contentHeight}
          onDeleteComment={deleteComment}
          onUpdateComment={(commentId, nextContent) => {
            updateComment(commentId, (current) => ({
              ...current,
              content: nextContent,
            }));
          }}
          onReplyComment={replyToComment}
          onSelectComment={selectComment}
          onFocusComment={focusComment}
          onHoverComment={setHoveredCommentId}
          onAcceptSuggestion={acceptSuggestion}
          onRejectSuggestion={rejectSuggestion}
          onReplySuggestion={replyToSuggestion}
          onSelectSuggestion={selectSuggestion}
          onFocusSuggestion={focusSuggestion}
          onHoverSuggestion={setHoveredChangeId}
          pendingFocusCommentId={pendingFocusCommentId}
          onAutoFocusComment={(commentId) => {
            setPendingFocusCommentId((current) =>
              current === commentId ? null : current,
            );
          }}
          draftSuggestion={draftSuggestion}
          onDraftSuggestionTextChange={(text) => {
            setDraftSuggestion((current) =>
              current ? { ...current, text } : current,
            );
          }}
          onApplyDraftSuggestion={applyDraftSuggestion}
          onCancelDraftSuggestion={() => setDraftSuggestion(null)}
          editor={editor}
        />
      </div>
    </div>
  );
});

const CodeEditorSurface = memo(function CodeEditorSurface({
  markdown,
  hasCommentRailSpace,
  interactionMode,
  layout,
  onMarkdownChange,
}: CodeEditorSurfaceProps) {
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "flex flex-col gap-6 min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,60rem)_minmax(24rem,1fr)] min-[1100px]:items-start min-[1100px]:justify-between min-[1100px]:gap-8",
    !hasCommentRailSpace && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasCommentRailSpace &&
      "min-[1100px]:grid-cols-[minmax(0,60rem)] min-[1100px]:justify-center",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo" ? "max-w-none" : "max-w-[60rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const reviewRailClass = cn(
    "document-comment-rail pointer-events-none invisible",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : "hidden min-[1100px]:block",
  );

  return (
    <div className="cursor-text bg-transparent" data-testid="page-card-code">
      <div data-testid="document-page-shell" className={documentShellClass}>
        <div className={documentMainClass}>
          <div className={contentInsetClass}>
            <div
              className="min-h-[calc(70vh+4rem)] rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-700 bg-white dark:bg-card py-10 pr-6 pl-5 shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)] sm:py-14 sm:pr-10 sm:pl-8"
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
        {hasCommentRailSpace ? (
          <div
            data-testid="document-review-rail"
            className={reviewRailClass}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
});

const PageCardEditorSurface = memo(function PageCardEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  onSave,
  onSaveStateChange,
  editorViewMode,
  interactionMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
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

  const hasCommentRailSpace = useMemo(
    () => reviewMarkdownHasReviewRail(markdown),
    [markdown],
  );

  useEffect(() => {
    if (editorViewMode !== "code") return;
    onCommentRailPresenceChange?.(hasCommentRailSpace);
  }, [editorViewMode, hasCommentRailSpace, onCommentRailPresenceChange]);

  if (editorViewMode === "code") {
    return (
      <CodeEditorSurface
        markdown={markdown}
        hasCommentRailSpace={hasCommentRailSpace}
        interactionMode={interactionMode}
        layout={layout}
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
      layout={layout}
      focusRequestKey={focusRequestKey}
      sourceMarkdown={effectiveRichTextSourceMarkdown}
      onMarkdownChange={handleMarkdownChange}
      interactionMode={interactionMode}
      onCommentRailPresenceChange={onCommentRailPresenceChange}
      backend={backend}
      onEditorReady={onEditorReady}
    />
  );
});

export function PageCard({
  page,
  activeDocumentPath = null,
  selected = false,
  layout = "default",
  focusRequestKey = null,
  onSave,
  onSaveStateChange,
  editorViewMode = "rich-text",
  interactionMode = "editing",
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
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
        layout={layout}
        focusRequestKey={focusRequestKey}
        onSave={onSave}
        onSaveStateChange={setSaveState}
        editorViewMode={editorViewMode}
        interactionMode={interactionMode}
        backend={backend}
        onEditorReady={onEditorReady}
        onCommentRailPresenceChange={onCommentRailPresenceChange}
        onDirtyStateChange={onDirtyStateChange}
        onLocalContentChange={onLocalContentChange}
        onSaveControllerChange={onSaveControllerChange}
        saveBlocked={saveBlocked}
        forceResetKey={forceResetKey}
      />
    </div>
  );
}
