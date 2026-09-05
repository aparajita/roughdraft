import { Check, X } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useRef,
  useState,
} from "react";
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
  "comment-thread": "Comment on:",
  suggestion: "Suggestion",
};

function isSubmitShortcut(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    event.key.toLowerCase() === "enter"
  );
}

function isSubmitAndCloseShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === "enter"
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
  const replyInputRef = useRef<HTMLTextAreaElement>(null);

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
    if (isSubmitAndCloseShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (canSubmit) {
        submitReply();
        onClose();
      }
      return;
    }

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
        initialFocus={replyInputRef}
        style={
          { "--review-thread-dialog-inset": VIEWPORT_INSET } as CSSProperties
        }
        className="top-[var(--review-thread-dialog-inset)] bottom-[var(--review-thread-dialog-inset)] h-auto w-[calc(var(--document-measure)+3rem)] max-w-[calc(100%-var(--review-thread-dialog-inset)*2)] translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden px-6 py-5"
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
              <Button
                type="button"
                variant="outline"
                className="text-base"
                onClick={onClose}
              >
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <DialogTitle className="text-base">
                  {ENTRY_TITLES[entry.kind]}
                </DialogTitle>
              </div>
              {excerpt !== null && (
                <div
                  data-testid="review-thread-dialog-excerpt"
                  className="rounded-md bg-muted/60 px-2.5 py-2 mb-2 text-base whitespace-pre-wrap text-slate-700 dark:text-slate-300"
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
            <div className="flex flex-col gap-3">
              <Textarea
                ref={replyInputRef}
                data-testid="review-thread-dialog-composer"
                aria-label="Reply"
                placeholder="Reply…"
                value={replyDraft}
                rows={2}
                className="px-2.5 text-base leading-5 md:text-base md:leading-5"
                onKeyDown={handleComposerKeyDown}
                onChange={(event) => {
                  setReplyDraft(event.target.value);
                }}
              />
              <div className="flex items-center justify-end gap-1.5">
                {entry.kind === "suggestion" && (
                  <div className="mr-auto flex shrink-0 items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-base text-emerald-600 dark:text-emerald-500"
                      data-testid="review-thread-dialog-action-accept"
                      onClick={() => {
                        onAcceptSuggestion(entry.id);
                      }}
                    >
                      <Check />
                      Accept
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-base text-red-600 dark:text-red-500"
                      data-testid="review-thread-dialog-action-reject"
                      onClick={() => {
                        onRejectSuggestion(entry.id);
                      }}
                    >
                      <X />
                      Reject
                    </Button>
                  </div>
                )}
                {entry.kind !== "suggestion" && (
                  <Button
                    type="button"
                    variant="outline"
                    aria-pressed={isResolved}
                    data-testid="review-thread-dialog-action-resolve"
                    className="mr-auto text-base"
                    onClick={() => {
                      onToggleResolved(entry.id, !isResolved);
                    }}
                  >
                    {isResolved ? "Reopen" : "Resolve"}
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={!canSubmit}
                  className="text-base bg-primary dark:bg-slate-700 text-primary-foreground dark:text-slate-100 hover:bg-stone-700 dark:hover:bg-slate-600"
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
