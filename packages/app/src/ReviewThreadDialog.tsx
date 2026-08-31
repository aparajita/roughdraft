import { Check, X } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useState } from "react";
import { CommentEditorList } from "./CommentEditorList";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import { Textarea } from "./components/ui/textarea";
import type { ReviewEntry } from "./document-comments";
import type { ReviewComment } from "./review";

export interface ReviewThreadDialogProps {
  entry: ReviewEntry | null;
  comments: ReviewComment[];
  excerpt: string | null;
  closedReason: string | null;
  onClose: () => void;
  onSubmitReply: (body: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onDeleteComment: (commentId: string) => void;
  onDeleteThread: (rootCommentId: string) => void;
  onToggleResolved: (rootCommentId: string, nextResolved: boolean) => void;
  onAcceptSuggestion: (suggestionId: string) => void;
  onRejectSuggestion: (suggestionId: string) => void;
}

/**
 * The gap the dialog leaves above and below itself. It is the only statement of
 * that measurement: the dialog's top edge, bottom edge and width clamp all read
 * it through the `--review-thread-dialog-inset` custom property below.
 *
 * The class names that read the property are written out in full because
 * Tailwind extracts candidates from the source text, so a class assembled from
 * this constant would generate no rule at all.
 */
const VIEWPORT_INSET = "2rem";

const ENTRY_TITLES: Record<ReviewEntry["kind"], string> = {
  "document-comment": "Document comment",
  "comment-thread": "Comment thread",
  suggestion: "Suggestion",
};

function isSubmitShortcut(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "enter"
  );
}

/**
 * The modal thread view: the excerpt the entry is anchored to, every comment in
 * the entry, and one composer.
 *
 * It holds no copy of the thread. `comments` is rendered on every render, so a
 * reload from disk that brings new comments shows them in place with no extra
 * wiring. When that reload removes the entry the dialog was open on, the owner
 * clears `entry` and passes `closedReason`, which the dialog reports in place
 * of the thread.
 *
 * Navigation between entries is unavailable while the dialog is open, so no
 * navigation control is rendered here.
 */
export function ReviewThreadDialog({
  entry,
  comments,
  excerpt,
  closedReason,
  onClose,
  onSubmitReply,
  onUpdateComment,
  onDeleteComment,
  onDeleteThread,
  onToggleResolved,
  onAcceptSuggestion,
  onRejectSuggestion,
}: ReviewThreadDialogProps) {
  const entryId = entry?.id ?? null;
  // A draft belongs to the thread it was typed into: it carries that thread's
  // id, so opening another entry shows an empty composer rather than the text
  // meant for somewhere else.
  const [draft, setDraft] = useState<{ entryId: string | null; body: string }>({
    entryId,
    body: "",
  });
  const replyDraft = draft.entryId === entryId ? draft.body : "";

  const setReplyDraft = (body: string) => {
    setDraft({ entryId, body });
  };

  const isOpen = entry !== null || closedReason !== null;
  const rootComment =
    entry === null
      ? undefined
      : comments.find((comment) => comment.id === entry.id);
  const isResolved = rootComment?.status === "resolved";
  const trimmedDraft = replyDraft.trim();
  const canSubmit = trimmedDraft.length > 0;

  const submitReply = () => {
    if (!canSubmit) return;

    onSubmitReply(trimmedDraft);
    setReplyDraft("");
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      submitReply();
      return;
    }

    if (event.key !== "Escape") return;

    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        data-testid="review-thread-dialog"
        style={
          { "--review-thread-dialog-inset": VIEWPORT_INSET } as CSSProperties
        }
        className="top-[var(--review-thread-dialog-inset)] bottom-[var(--review-thread-dialog-inset)] h-auto w-[48rem] max-w-[calc(100%-var(--review-thread-dialog-inset)*2)] translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden p-4"
      >
        {entry === null ? (
          <>
            <div>
              <DialogTitle>Thread unavailable</DialogTitle>
            </div>
            <DialogDescription
              data-testid="review-thread-dialog-closed-reason"
              className="self-start"
            >
              {closedReason}
            </DialogDescription>
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2 pr-8">
              <div className="flex items-center gap-1.5">
                <DialogTitle className="text-sm">
                  {ENTRY_TITLES[entry.kind]}
                </DialogTitle>
                {entry.kind === "suggestion" && (
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      data-testid="review-thread-dialog-action-accept"
                      aria-label="Accept suggestion"
                      className="flex size-6 items-center justify-center rounded-full text-emerald-600 transition hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 dark:text-emerald-500 dark:hover:bg-emerald-950 dark:focus-visible:ring-emerald-800"
                      onClick={() => {
                        onAcceptSuggestion(entry.id);
                      }}
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      data-testid="review-thread-dialog-action-reject"
                      aria-label="Reject suggestion"
                      className="flex size-6 items-center justify-center rounded-full text-red-600 transition hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 dark:text-red-500 dark:hover:bg-red-950 dark:focus-visible:ring-red-800"
                      onClick={() => {
                        onRejectSuggestion(entry.id);
                      }}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
              {excerpt !== null && (
                <div
                  data-testid="review-thread-dialog-excerpt"
                  className="h-20 overflow-y-auto rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[13px] leading-5 whitespace-pre-wrap text-slate-700 dark:text-slate-300"
                >
                  {excerpt}
                </div>
              )}
            </div>
            <div className="min-h-0 overflow-y-auto pr-1">
              <CommentEditorList
                comments={comments}
                onUpdateComment={onUpdateComment}
                onDeleteComment={onDeleteComment}
                onDeleteThread={onDeleteThread}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Textarea
                data-testid="review-thread-dialog-composer"
                aria-label="Reply"
                placeholder="Reply…"
                value={replyDraft}
                rows={2}
                className="px-2.5 text-[13px] leading-5 md:text-[13px] md:leading-5"
                onKeyDown={handleComposerKeyDown}
                onChange={(event) => {
                  setReplyDraft(event.target.value);
                }}
              />
              <div className="flex items-center justify-end gap-1.5">
                {entry.kind !== "suggestion" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-pressed={isResolved}
                    data-testid="review-thread-dialog-action-resolve"
                    className="mr-auto"
                    onClick={() => {
                      onToggleResolved(entry.id, !isResolved);
                    }}
                  >
                    {isResolved ? "Reopen" : "Resolve"}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  disabled={!canSubmit}
                  data-testid="review-thread-dialog-action-submit"
                  onClick={submitReply}
                >
                  Reply
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
