import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  CodeXml,
  Copy,
  Eye,
  Loader2,
  MessageSquarePlus,
  PencilLine,
  RefreshCcw,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentEditorViewMode } from "./app-navigation";
import { RemoteSessionBanner } from "./components/RemoteSessionBanner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
} from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  COMMENT_ANCHOR_SELECTOR,
  DELETION_ANCHOR_SELECTOR,
  INSERTION_ANCHOR_SELECTOR,
  REPLACEMENT_ANCHOR_SELECTOR,
} from "./document-comments";
import type { DocumentDiskChangeState } from "./document-disk-change-state";
import {
  getReviewHandoffButtonLabel,
  isDocumentSaveBlocked,
  isReviewHandoffDisabled,
  type ReviewHandoffState,
  shouldLatchDocumentChangedSinceOpen,
} from "./document-save-and-handoff";
import { cn } from "./lib/utils";
import {
  HEADING_BLANK_AFTER_ATTRIBUTE,
  HEADING_BLANK_BEFORE_ATTRIBUTE,
} from "./markdown";
import {
  type DocumentInteractionMode,
  type DocumentSaveController,
  type DocumentSaveState,
  PageCard,
} from "./PageCard";
import { reviewMarkdownToRenderedHtml } from "./review";
import type { CompleteReviewOptions, Page, StorageBackend } from "./storage";

type FileCopyAction = "path" | "filename" | "markdown" | "rich-text";
const FILE_COPY_PREVIEW_MAX_LENGTH = 34;
const reviewCompleteTitles = [
  "Great work!",
  "Nice one!",
  "Well done!",
  "All set!",
  "Review complete!",
  "That’ll do!",
  "Lovely stuff!",
  "Job done!",
  "Done and dusted!",
  "Nailed it!",
  "Good stuff!",
  "Sorted!",
  "Cracking work!",
  "Top work!",
  "Brilliant!",
  "Ace!",
  "Spot on!",
  "Beauty!",
  "Too easy!",
  "Good on ya!",
  "You’re golden!",
  "That’s the ticket!",
  "And that’s that!",
  "Wrapped!",
  "In the bag!",
  "Shipshape!",
  "Right as rain!",
] as const;
type ReviewCompleteTitle = (typeof reviewCompleteTitles)[number];

function buildReviewHandoffCopyMessage(documentPath: string) {
  return `I am done reviewing this file: ${documentPath}`;
}

function getRandomReviewCompleteTitle(random: () => number = Math.random) {
  const index = Math.floor(random() * reviewCompleteTitles.length);
  return reviewCompleteTitles[Math.min(index, reviewCompleteTitles.length - 1)];
}

function getRandomReviewCompleteTitleExcept(
  currentTitle: ReviewCompleteTitle,
  random: () => number = Math.random,
): ReviewCompleteTitle {
  const otherTitles = reviewCompleteTitles.filter(
    (title) => title !== currentTitle,
  );
  if (otherTitles.length === 0) return currentTitle;

  const index = Math.floor(random() * otherTitles.length);
  return otherTitles[Math.min(index, otherTitles.length - 1)];
}

const documentInteractionModeOptions = [
  { value: "editing", label: "Editing", Icon: PencilLine },
  { value: "suggesting", label: "Suggesting", Icon: MessageSquarePlus },
  { value: "viewing", label: "Viewing", Icon: Eye },
] satisfies {
  value: DocumentInteractionMode;
  label: string;
  Icon: typeof Eye;
}[];

const conflictNoticeCopy: Record<
  Exclude<DocumentDiskChangeState, "clean">,
  {
    title: string;
    body: string;
  }
> = {
  changed: {
    title: "File changed on disk",
    body: "Roughdraft found a newer version of this file on disk. Reload to use that version, or overwrite it with your current draft.",
  },
  conflict: {
    title: "Save conflict",
    body: "This file changed on disk while you have unsaved edits. Autosave is paused so your draft will not overwrite those changes.",
  },
  paused: {
    title: "Autosave paused",
    body: "Keep editing locally, then reload from disk to discard your draft or overwrite the disk file when you are ready.",
  },
};

const fileCopyMenuOptions = [
  { action: "path", label: "Path" },
  { action: "filename", label: "Filename" },
  { action: "markdown", label: "Markdown" },
  { action: "rich-text", label: "Rich text" },
] satisfies {
  action: FileCopyAction;
  label: string;
}[];

function formatFileCopyPreview(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= FILE_COPY_PREVIEW_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, FILE_COPY_PREVIEW_MAX_LENGTH - 1)}...`;
}

async function writePlainTextToClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

function markdownToPlainText(markdown: string) {
  const template = document.createElement("template");
  template.innerHTML = markdownToCleanRichHtml(markdown);
  return (template.content.textContent ?? "").trimEnd();
}

function unwrapElement(element: HTMLElement) {
  element.replaceWith(...element.childNodes);
}

function removeAll(root: ParentNode, selector: string) {
  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>(selector),
  )) {
    element.remove();
  }
}

function unwrapAll(root: ParentNode, selector: string) {
  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>(selector),
  )) {
    unwrapElement(element);
  }
}

/**
 * Copying a document copies the text as it stands today: suggested insertions
 * are dropped, suggested deletions are kept, and review anchors leave no markup
 * behind. Only anchors carrying an `rd-` id are touched, so plain `<ins>`,
 * `<del>` and `<span>` markup in the document survives.
 */
function markdownToCleanRichHtml(markdown: string) {
  const template = document.createElement("template");
  template.innerHTML = reviewMarkdownToRenderedHtml(markdown).html;

  removeAll(template.content, "[data-comment-anchorless='true']");
  unwrapAll(template.content, COMMENT_ANCHOR_SELECTOR);

  for (const replacement of Array.from(
    template.content.querySelectorAll<HTMLElement>(REPLACEMENT_ANCHOR_SELECTOR),
  )) {
    removeAll(replacement, "ins");
    unwrapAll(replacement, "del");
    unwrapElement(replacement);
  }

  removeAll(template.content, INSERTION_ANCHOR_SELECTOR);
  unwrapAll(template.content, DELETION_ANCHOR_SELECTOR);

  // Heading spacing is bookkeeping the Markdown round trip needs and a reader
  // pasting into another application does not.
  for (const attribute of [
    HEADING_BLANK_BEFORE_ATTRIBUTE,
    HEADING_BLANK_AFTER_ATTRIBUTE,
  ]) {
    for (const heading of Array.from(
      template.content.querySelectorAll<HTMLElement>(`[${attribute}]`),
    )) {
      heading.removeAttribute(attribute);
    }
  }

  return template.innerHTML;
}

async function writeRichTextToClipboard(markdown: string) {
  const clipboardWithRichText = navigator.clipboard as Clipboard & {
    write?: Clipboard["write"];
  };
  const html = markdownToCleanRichHtml(markdown);
  const plainText = markdownToPlainText(markdown);

  if (clipboardWithRichText.write && typeof ClipboardItem !== "undefined") {
    await clipboardWithRichText.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      }),
    ]);
    return;
  }

  await writePlainTextToClipboard(plainText);
}

export function SaveFailedAlertDialog({
  open,
  onOpenChange,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="save-failed-alert">
        <AlertDialogHeader>
          <AlertDialogTitle>Save failed</AlertDialogTitle>
          <AlertDialogDescription>
            The document failed to save. Try again?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="save-failed-alert-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="save-failed-alert-retry"
            onClick={onRetry}
          >
            OK
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface DocumentWorkspaceProps {
  documentPage: Page | null;
  activeDocumentPath: string | null;
  documentCopyPath: string | null;
  documentFilenameLabel: string;
  documentEditorViewMode: DocumentEditorViewMode;
  onDocumentEditorViewModeChange: (mode: DocumentEditorViewMode) => void;
  onSaveDocument: (id: string, content: string) => Promise<void>;
  onDocumentSaveStateChange: (state: DocumentSaveState) => void;
  onDocumentDirtyStateChange: (isDirty: boolean) => void;
  onDocumentLocalContentChange: (markdown: string) => void;
  documentDiskChangeState: DocumentDiskChangeState;
  documentForceResetKey: string | null;
  onReloadDocumentFromDisk: () => void | Promise<void>;
  onKeepEditingWithoutAutosave: () => void;
  onOverwriteDocumentOnDisk: () => void | Promise<void>;
  onCompleteReview: (
    options?: CompleteReviewOptions,
  ) => Promise<{ delivered: boolean }>;
  backend: StorageBackend | null;
}

export function DocumentWorkspace({
  documentPage,
  activeDocumentPath,
  documentCopyPath,
  documentFilenameLabel,
  documentEditorViewMode,
  onDocumentEditorViewModeChange,
  onSaveDocument,
  onDocumentSaveStateChange,
  onDocumentDirtyStateChange,
  onDocumentLocalContentChange,
  documentDiskChangeState,
  documentForceResetKey,
  onReloadDocumentFromDisk,
  onKeepEditingWithoutAutosave,
  onOverwriteDocumentOnDisk,
  onCompleteReview,
  backend,
}: DocumentWorkspaceProps) {
  const [documentInteractionMode, setDocumentInteractionMode] =
    useState<DocumentInteractionMode>("suggesting");
  const [reviewFooterVisible, setReviewFooterVisible] = useState(false);
  const [saveState, setSaveState] = useState<DocumentSaveState>("saved");
  const [saveErrorAlertOpen, setSaveErrorAlertOpen] = useState(false);
  const [reviewHandoffState, setReviewHandoffState] =
    useState<ReviewHandoffState>("idle");
  const [reviewWatcherCount, setReviewWatcherCount] = useState(0);
  const [reviewHandoffPopoverOpen, setReviewHandoffPopoverOpen] =
    useState(false);
  const [reviewCompleteTitle, setReviewCompleteTitle] = useState(() =>
    getRandomReviewCompleteTitle(),
  );
  const [fileCopyMenuOpen, setFileCopyMenuOpen] = useState(false);
  const [copiedFileAction, setCopiedFileAction] =
    useState<FileCopyAction | null>(null);
  const [overallComment, setOverallComment] = useState("");
  const [documentChangedSinceOpen, setDocumentChangedSinceOpen] =
    useState(false);
  const sawNoWatcherAfterNotifiedRef = useRef(false);
  const copiedFileActionTimeoutRef = useRef<number | null>(null);
  const saveControllerRef = useRef<DocumentSaveController | null>(null);
  const documentChangeTrackingReadyRef = useRef(false);

  const handleSaveStateChange = useCallback(
    (state: DocumentSaveState) => {
      setSaveState(state);
      onDocumentSaveStateChange(state);
    },
    [onDocumentSaveStateChange],
  );

  useEffect(() => {
    const documentIdentity = `${activeDocumentPath ?? ""}:${documentPage?.id ?? ""}`;
    if (!documentIdentity) return;
    documentChangeTrackingReadyRef.current = false;
    setReviewHandoffState("idle");
    setReviewHandoffPopoverOpen(false);
    setDocumentChangedSinceOpen(false);
    const readyTimer = window.setTimeout(() => {
      documentChangeTrackingReadyRef.current = true;
    }, 0);
    return () => window.clearTimeout(readyTimer);
  }, [activeDocumentPath, documentPage?.id]);

  useEffect(() => {
    if (!backend?.getReviewWatchStatus || !activeDocumentPath) {
      setReviewWatcherCount(0);
      return;
    }

    let cancelled = false;
    const refreshWatchStatus = async () => {
      try {
        const status = await backend.getReviewWatchStatus?.(activeDocumentPath);
        if (!cancelled) {
          setReviewWatcherCount(status?.watcherCount ?? 0);
        }
      } catch {
        if (!cancelled) {
          setReviewWatcherCount(0);
        }
      }
    };

    void refreshWatchStatus();
    const interval = window.setInterval(refreshWatchStatus, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeDocumentPath, backend]);

  useEffect(() => {
    if (reviewHandoffState === "undelivered" && reviewWatcherCount > 0) {
      setReviewHandoffState("idle");
      return;
    }

    if (reviewHandoffState !== "notified") {
      sawNoWatcherAfterNotifiedRef.current = false;
      return;
    }

    if (reviewWatcherCount === 0) {
      sawNoWatcherAfterNotifiedRef.current = true;
      return;
    }

    if (sawNoWatcherAfterNotifiedRef.current) {
      sawNoWatcherAfterNotifiedRef.current = false;
      setReviewHandoffState("idle");
    }
  }, [reviewHandoffState, reviewWatcherCount]);

  useEffect(() => {
    if (reviewHandoffState === "notified") {
      setReviewCompleteTitle((currentTitle) =>
        getRandomReviewCompleteTitleExcept(currentTitle),
      );
    }
  }, [reviewHandoffState]);

  useEffect(() => {
    return () => {
      if (copiedFileActionTimeoutRef.current !== null) {
        window.clearTimeout(copiedFileActionTimeoutRef.current);
      }
    };
  }, []);

  const handleManualSave = useCallback(() => {
    if (isDocumentSaveBlocked(documentDiskChangeState)) return;

    void saveControllerRef.current?.flushSave();
  }, [documentDiskChangeState]);

  useEffect(() => {
    if (!documentPage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut =
        event.key.toLowerCase() === "s" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey;

      if (!isSaveShortcut) return;

      // The browser's Save Page dialog is always wrong inside the editor, so
      // swallow the shortcut even when the save itself cannot proceed.
      event.preventDefault();
      event.stopPropagation();

      handleManualSave();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [documentPage, handleManualSave]);

  useEffect(() => {
    // A disk conflict rejects the save too, but the conflict banner already
    // names and resolves that state; this alert is only for a write that
    // failed for its own reasons.
    if (isDocumentSaveBlocked(documentDiskChangeState)) {
      setSaveErrorAlertOpen(false);
      return;
    }
    if (saveState === "error") setSaveErrorAlertOpen(true);
  }, [saveState, documentDiskChangeState]);

  const handleRetrySaveAfterError = useCallback(() => {
    void saveControllerRef.current?.flushSave().then((result) => {
      if (result && result.status !== "error") setSaveErrorAlertOpen(false);
    });
  }, []);

  const handleCompleteReview = useCallback(
    async (options?: CompleteReviewOptions) => {
      if (!activeDocumentPath || reviewHandoffState === "notifying") return;

      setReviewHandoffState("notifying");
      try {
        // The button stays enabled while autosave is still pending, so make
        // sure any debounced edits are persisted before handing off.
        const flushResult = await saveControllerRef.current?.flushSave();
        if (flushResult && flushResult.status === "error") {
          throw flushResult.error;
        }

        const result = await onCompleteReview(options);
        if (result.delivered) {
          setReviewWatcherCount(0);
          setReviewHandoffState("notified");
          setOverallComment("");
          setReviewHandoffPopoverOpen(true);
        } else {
          setReviewWatcherCount(0);
          setReviewHandoffState("undelivered");
          setReviewHandoffPopoverOpen(true);
        }
      } catch (error) {
        console.error("Failed to complete review:", error);
        setReviewHandoffState("error");
        setReviewHandoffPopoverOpen(true);
      }
    },
    [activeDocumentPath, onCompleteReview, reviewHandoffState],
  );

  const handleDocumentDirtyStateChange = useCallback(
    (isDirty: boolean) => {
      if (
        shouldLatchDocumentChangedSinceOpen({
          isDirty,
          documentChangeTrackingReady: documentChangeTrackingReadyRef.current,
        })
      ) {
        setDocumentChangedSinceOpen(true);
      }
      onDocumentDirtyStateChange(isDirty);
    },
    [onDocumentDirtyStateChange],
  );

  const handleCopyFileMenuAction = useCallback(
    async (action: FileCopyAction) => {
      if (!documentPage) return;

      const copyTextByAction: Record<
        Exclude<FileCopyAction, "rich-text">,
        string
      > = {
        path: documentCopyPath ?? activeDocumentPath ?? documentFilenameLabel,
        filename: documentFilenameLabel,
        markdown: documentPage.content,
      };

      try {
        if (action === "rich-text") {
          await writeRichTextToClipboard(documentPage.content);
        } else {
          await writePlainTextToClipboard(copyTextByAction[action]);
        }

        setCopiedFileAction(action);
        if (copiedFileActionTimeoutRef.current !== null) {
          window.clearTimeout(copiedFileActionTimeoutRef.current);
        }
        copiedFileActionTimeoutRef.current = window.setTimeout(() => {
          setCopiedFileAction(null);
          copiedFileActionTimeoutRef.current = null;
        }, 3000);
      } catch (error) {
        console.error("Failed to copy document data:", error);
      }
    },
    [activeDocumentPath, documentCopyPath, documentFilenameLabel, documentPage],
  );

  const editorViewModeToggleLabel =
    documentEditorViewMode === "rich-text"
      ? "Switch to code view"
      : "Switch to rich text view";
  const fileCopyPreviewByAction: Record<FileCopyAction, string> = {
    path: formatFileCopyPreview(
      documentCopyPath ?? activeDocumentPath ?? documentFilenameLabel,
    ),
    filename: formatFileCopyPreview(documentFilenameLabel),
    markdown: formatFileCopyPreview(documentPage?.content ?? ""),
    "rich-text": formatFileCopyPreview(
      documentPage ? markdownToPlainText(documentPage.content) : "",
    ),
  };
  const activeDocumentInteractionMode = documentInteractionModeOptions.find(
    (option) => option.value === documentInteractionMode,
  );
  const ActiveDocumentInteractionModeIcon =
    activeDocumentInteractionMode?.Icon ?? PencilLine;
  const conflictNotice =
    documentDiskChangeState === "clean"
      ? null
      : conflictNoticeCopy[documentDiskChangeState];
  const showReviewHandoffButton =
    !!activeDocumentPath &&
    (reviewWatcherCount > 0 || reviewHandoffState !== "idle");
  const reviewHandoffButtonLabel = getReviewHandoffButtonLabel({
    reviewHandoffState,
    documentChangedSinceOpen,
  });
  const ReviewHandoffButtonIcon =
    reviewHandoffState === "notifying"
      ? Loader2
      : reviewHandoffState === "error" || reviewHandoffState === "undelivered"
        ? AlertTriangle
        : null;
  const reviewHandoffStatusTitle =
    reviewHandoffState === "undelivered"
      ? "No agent is watching now"
      : reviewHandoffState === "error"
        ? "Could not notify agent"
        : reviewCompleteTitle;
  const reviewHandoffStatusBody =
    reviewHandoffState === "undelivered"
      ? "The handoff was not delivered because the watcher is no longer connected."
      : reviewHandoffState === "error"
        ? "Roughdraft could not send the handoff. Check that the local server is still running."
        : null;
  const reviewHandoffCopyMessage = buildReviewHandoffCopyMessage(
    activeDocumentPath ?? documentFilenameLabel,
  );
  const reviewHandoffDisabled = isReviewHandoffDisabled({
    saveState,
    documentDiskChangeState,
    reviewHandoffState,
  });
  const reviewHandoffButtonDisabled =
    reviewHandoffDisabled && reviewHandoffState !== "notified";
  const trimmedOverallComment = overallComment.trim();

  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-6 pb-4 sm:px-6",
        conflictNotice ? "pt-40 sm:pt-28" : "pt-4",
      )}
    >
      <RemoteSessionBanner backend={backend} />
      <SaveFailedAlertDialog
        open={saveErrorAlertOpen}
        onOpenChange={setSaveErrorAlertOpen}
        onRetry={handleRetrySaveAfterError}
      />
      <div
        className={cn(
          "fixed right-3 z-60 flex max-w-[min(22rem,calc(100vw-1rem))] flex-col items-end gap-1.5",
          conflictNotice ? "top-76 sm:top-28" : "top-3",
        )}
        data-testid="document-status-stack"
        data-document-status-stack="true"
      >
        <div className="flex max-w-full items-center justify-end gap-1.5">
          {showReviewHandoffButton ? (
            <Popover
              open={reviewHandoffPopoverOpen}
              onOpenChange={setReviewHandoffPopoverOpen}
            >
              <div
                data-testid="review-handoff-split-button"
                className={cn(
                  "relative flex items-center overflow-hidden rounded-[7px] shadow-lg transition-opacity after:pointer-events-none after:absolute after:top-px after:right-8 after:bottom-px after:z-10 after:w-px after:bg-stone-700 after:content-['']",
                  reviewHandoffDisabled && "opacity-50",
                )}
              >
                <Button
                  type="button"
                  data-testid="review-handoff-button"
                  size="lg"
                  className="h-8 rounded-r-none rounded-l-[7px] border-0 bg-primary dark:bg-slate-700 dark:text-slate-100 px-3 text-sm font-semibold text-primary-foreground hover:bg-stone-700 dark:hover:bg-slate-600 focus-visible:ring-ring disabled:opacity-100"
                  disabled={reviewHandoffButtonDisabled}
                  aria-disabled={reviewHandoffButtonDisabled || undefined}
                  onClick={() => {
                    if (reviewHandoffState === "notified") {
                      setReviewHandoffPopoverOpen(true);
                      return;
                    }

                    void handleCompleteReview(
                      trimmedOverallComment
                        ? { overallComment: trimmedOverallComment }
                        : undefined,
                    );
                  }}
                >
                  {ReviewHandoffButtonIcon ? (
                    <ReviewHandoffButtonIcon
                      className={cn(
                        "size-4",
                        reviewHandoffState === "notifying" && "animate-spin",
                      )}
                    />
                  ) : null}
                  {reviewHandoffButtonLabel}
                </Button>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      data-testid="review-handoff-comment-trigger"
                      size="icon-lg"
                      className="h-8 w-8 rounded-l-none rounded-r-[7px] border-0 bg-primary dark:bg-slate-700 text-primary-foreground dark:text-slate-100 hover:bg-stone-700 dark:hover:bg-slate-600 focus-visible:ring-ring disabled:opacity-100"
                      disabled={reviewHandoffDisabled}
                      aria-label="Add overall handoff comment"
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                  }
                />
              </div>
              <PopoverContent
                className={reviewHandoffState === "idle" ? undefined : "pt-0"}
                aria-label={
                  reviewHandoffState === "idle"
                    ? "Review handoff comment"
                    : "Review handoff status"
                }
                data-testid={
                  reviewHandoffState === "idle"
                    ? "review-handoff-comment-popover"
                    : "review-handoff-status"
                }
              >
                {reviewHandoffState === "idle" ? (
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleCompleteReview({
                        overallComment: trimmedOverallComment,
                      });
                    }}
                  >
                    <div>
                      <Textarea
                        id="review-handoff-overall-comment"
                        data-testid="review-handoff-overall-comment"
                        aria-label="Overall comment"
                        placeholder="Overall comment"
                        value={overallComment}
                        onChange={(event) =>
                          setOverallComment(event.currentTarget.value)
                        }
                        maxLength={4000}
                        rows={4}
                        className="min-h-24 resize-none"
                      />
                    </div>
                    <Button
                      type="submit"
                      data-testid="review-handoff-submit-comment"
                      size="lg"
                      className="w-full rounded-[7px] bg-black text-sm font-semibold bg-primary dark:bg-slate-700 text-primary-foreground dark:text-slate-100 hover:bg-stone-700 dark:hover:bg-slate-600"
                      disabled={!trimmedOverallComment}
                    >
                      <CheckCheck className="size-4" />
                      Submit with comment
                    </Button>
                  </form>
                ) : (
                  <div>
                    <div className="flex items-start gap-3">
                      {reviewHandoffState === "notifying" ||
                      reviewHandoffState === "error" ||
                      reviewHandoffState === "undelivered" ? (
                        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black">
                          {reviewHandoffState === "notifying" ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <AlertTriangle className="size-4" />
                          )}
                        </span>
                      ) : null}
                      <div>
                        {reviewHandoffStatusBody ? (
                          <p className="mt-3 text-sm leading-6 text-stone-700 dark:text-slate-100">
                            {reviewHandoffStatusBody}
                          </p>
                        ) : (
                          <div className="mt-3">
                            <p className="text-sm leading-[1.32rem] text-stone-700 dark:text-slate-100">
                              Your agent is now working in the background on
                              this, in all likelihood. If our signal didn't make
                              it, just{" "}
                              <button
                                type="button"
                                data-testid="review-handoff-copy-message"
                                className="font-normal text-inherit underline decoration-stone-300 underline-offset-4 hover:decoration-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-950/25 dark:decoration-slate-600 dark:hover:decoration-slate-200 dark:focus-visible:ring-slate-50/30"
                                onClick={() =>
                                  void writePlainTextToClipboard(
                                    reviewHandoffCopyMessage,
                                  )
                                }
                              >
                                click here
                              </button>{" "}
                              to copy a line you can send it to keep going.
                            </p>
                            <Button
                              type="button"
                              data-testid="review-handoff-close-window"
                              size="lg"
                              variant="outline"
                              className="mt-4 w-full rounded-[7px] text-sm font-semibold"
                              onClick={() => window.close()}
                            >
                              Close window
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      {conflictNotice ? (
        <div
          data-testid="file-conflict-notice"
          role="status"
          aria-label="File conflict"
          className="fixed top-3 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 flex-col gap-3 rounded-[8px] border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-3 text-amber-950 dark:text-amber-100 shadow-lg sm:flex-row sm:items-center sm:justify-between sm:px-4"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-5">
                {conflictNotice.title}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
                {conflictNotice.body}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
            <Button
              type="button"
              data-testid="file-conflict-action-reload"
              variant="ghost"
              size="sm"
              className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
              onClick={() => void onReloadDocumentFromDisk()}
            >
              <RefreshCcw className="size-3.5" />
              Reload from disk
            </Button>
            {documentDiskChangeState !== "paused" ? (
              <Button
                type="button"
                data-testid="file-conflict-action-keep-editing"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] bg-white/55 dark:bg-white/10 px-2 text-xs text-amber-950 dark:text-amber-100 hover:bg-white dark:hover:bg-white/20"
                onClick={onKeepEditingWithoutAutosave}
              >
                <PencilLine className="size-3.5" />
                Keep editing with autosave paused
              </Button>
            ) : null}
            <Button
              type="button"
              data-testid="file-conflict-action-overwrite"
              variant="ghost"
              size="sm"
              className="h-8 rounded-[7px] bg-amber-900 dark:bg-amber-600 px-2 text-xs text-white hover:bg-amber-800 dark:hover:bg-amber-500"
              onClick={() => void onOverwriteDocumentOnDisk()}
            >
              <Upload className="size-3.5" />
              Overwrite disk file
            </Button>
          </div>
        </div>
      ) : null}
      <div className="mx-auto min-h-full max-w-270">
        {documentPage ? (
          <div
            data-testid="document-page-header"
            className={cn(
              "review-layout-grid document-page-shell mb-2 text-[0.62rem] font-medium tracking-[0.01em] text-stone-400",
              reviewFooterVisible && "review-layout-grid--centered",
            )}
          >
            <div className="review-layout-main document-page-main w-full max-w-(--document-measure) min-w-0">
              <div className="flex w-full flex-wrap items-center gap-1.5 px-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        data-testid="document-editor-view-toggle"
                        className="grid shrink-0 grid-cols-2 rounded-[999px] bg-secondary px-0.5 pt-0.75 pb-0.5"
                      >
                        <span
                          className={`flex w-5.5 items-center justify-center rounded-full py-0.5 transition ${
                            documentEditorViewMode === "rich-text"
                              ? "bg-card text-stone-700 dark:text-white shadow-sm"
                              : "text-stone-500 dark:text-slate-400"
                          }`}
                        >
                          <Eye className="size-3" />
                        </span>
                        <span
                          className={`flex w-5.5 items-center justify-center rounded-full py-0.5 transition ${
                            documentEditorViewMode === "code"
                              ? "bg-card text-stone-700 dark:text-white shadow-sm"
                              : "text-stone-500 dark:text-slate-400"
                          }`}
                        >
                          <CodeXml className="size-3" />
                        </span>
                      </button>
                    }
                    aria-label={editorViewModeToggleLabel}
                    onClick={() =>
                      onDocumentEditorViewModeChange(
                        documentEditorViewMode === "rich-text"
                          ? "code"
                          : "rich-text",
                      )
                    }
                  />
                  <TooltipContent>{editorViewModeToggleLabel}</TooltipContent>
                </Tooltip>
                <Popover
                  open={fileCopyMenuOpen}
                  onOpenChange={setFileCopyMenuOpen}
                >
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        data-testid="document-file-menu-trigger"
                        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1 py-0.5 text-base leading-none font-medium text-stone-400 outline-none transition hover:text-stone-500 focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:text-slate-300 dark:hover:text-slate-200 dark:focus-visible:ring-slate-600/70"
                        title={documentFilenameLabel}
                        aria-label="Document file actions"
                      >
                        <span className="min-w-0 truncate">
                          {documentFilenameLabel}
                        </span>
                        <ChevronDown
                          className="size-[0.62rem] shrink-0"
                          aria-hidden="true"
                        />
                      </button>
                    }
                  />
                  <PopoverContent
                    aria-label="Document file actions"
                    data-testid="document-file-menu"
                    className="w-56 p-1"
                    align="start"
                    sideOffset={4}
                  >
                    <div className="flex flex-col">
                      {fileCopyMenuOptions.map(({ action, label }) => (
                        <button
                          key={action}
                          type="button"
                          data-testid={`document-file-menu-${action}`}
                          className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-base leading-none text-stone-700 outline-none transition hover:bg-accent focus-visible:bg-accent dark:text-stone-300"
                          onClick={() => void handleCopyFileMenuAction(action)}
                        >
                          <Copy
                            className="mt-[0.06rem] size-4 shrink-0 text-stone-500 dark:text-slate-400"
                            aria-hidden="true"
                          />
                          <span className="grid min-w-0 flex-1 gap-1">
                            <span className="truncate font-medium">
                              {copiedFileAction === action ? "Copied!" : label}
                            </span>
                            <span className="truncate text-sm leading-none text-stone-400 dark:text-slate-500">
                              {fileCopyPreviewByAction[action]}
                            </span>
                          </span>
                          {copiedFileAction === action ? (
                            <Check className="mt-[0.06rem] ml-auto size-3 shrink-0 text-stone-500 dark:text-stone-400" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <div className="ml-auto inline-flex h-5 shrink-0 items-center">
                  <Select<DocumentInteractionMode>
                    value={documentInteractionMode}
                    onValueChange={(value) => {
                      if (value) setDocumentInteractionMode(value);
                    }}
                  >
                    <SelectTrigger
                      data-testid="document-mode-trigger"
                      aria-label="Document mode"
                      className="h-6 gap-1.5 px-1 text-base leading-none font-medium tracking-[0.01em] text-stone-400 dark:text-slate-300 hover:text-stone-500 dark:hover:text-slate-200"
                    >
                      <ActiveDocumentInteractionModeIcon className="size-[0.8rem]" />
                      <span className="truncate">
                        {activeDocumentInteractionMode?.label}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {documentInteractionModeOptions.map(
                        ({ value, label, Icon }) => (
                          <SelectItem
                            key={value}
                            value={value}
                            label={label}
                            data-testid={`document-mode-option-${value}`}
                            className="text-[0.8rem]"
                          >
                            <Icon className="size-3 text-stone-500 dark:text-slate-400" />
                            <SelectItemText className="font-medium text-base">
                              {label}
                            </SelectItemText>
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {documentPage ? (
          backend ? (
            <PageCard
              key={`${documentPage.id}:${activeDocumentPath ?? ""}`}
              page={documentPage}
              activeDocumentPath={activeDocumentPath}
              selected
              onSave={onSaveDocument}
              onSaveStateChange={handleSaveStateChange}
              editorViewMode={documentEditorViewMode}
              interactionMode={documentInteractionMode}
              backend={backend}
              onDirtyStateChange={handleDocumentDirtyStateChange}
              onLocalContentChange={onDocumentLocalContentChange}
              onSaveControllerChange={(controller) => {
                saveControllerRef.current = controller;
              }}
              saveBlocked={isDocumentSaveBlocked(documentDiskChangeState)}
              forceResetKey={documentForceResetKey}
              onReviewFooterVisibleChange={setReviewFooterVisible}
            />
          ) : null
        ) : (
          <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Open a markdown file to begin.
          </div>
        )}
      </div>
    </div>
  );
}
