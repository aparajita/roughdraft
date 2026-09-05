import { Check, FileText, Trash2, X } from "lucide-react";
import type { ReviewEntry, SuggestionOperation } from "./document-comments";
import { cn } from "./lib/utils";
import { ReviewButton } from "./ReviewButton";
import type { ReviewComment } from "./review";

const THREAD_SEGMENT_SEPARATOR = " → ";

export interface ReviewEntryChipProps {
  entry: ReviewEntry | null;
  comments: ReadonlyMap<string, ReviewComment>;
  isCurrent: boolean;
  isResolved: boolean;
  onSelect?: () => void;
  onOpenDialog?: () => void;
  onDeleteThread?: (rootCommentId: string) => void;
  onAcceptSuggestion?: (suggestionId: string) => void;
  onRejectSuggestion?: (suggestionId: string) => void;
}

const SUGGESTION_OPERATION_LABELS: Record<SuggestionOperation, string> = {
  insert: "Insert",
  delete: "Delete",
  replace: "Replace",
};

const NO_COMMENTS_LABEL = "No comments";

function commentCountLabel(count: number): string {
  if (count === 0) {
    return NO_COMMENTS_LABEL;
  }

  return count === 1 ? "1 comment:" : `${count} comments:`;
}

/**
 * One line, one entry: the shared summary rendered by both the review rail
 * and the narrow-width footer, so the two can never drift from each other.
 */
export function ReviewEntryChip({
  entry,
  comments,
  isCurrent,
  isResolved,
  onSelect,
  onOpenDialog,
  onDeleteThread,
  onAcceptSuggestion,
  onRejectSuggestion,
}: ReviewEntryChipProps) {
  if (!entry) {
    return (
      <div
        data-testid="review-entry-chip-empty"
        className={cn(
          "flex h-8 w-full items-center gap-1.5 rounded-md border px-2",
          isCurrent ? "border-border bg-card" : "border-transparent",
        )}
      >
        <span className="truncate whitespace-nowrap text-sm leading-5 text-muted-foreground">
          {NO_COMMENTS_LABEL}
        </span>
      </div>
    );
  }

  const commentCount = entry.commentIds.length;
  const threadContent = entry.commentIds
    .map((commentId) => comments.get(commentId)?.content)
    .filter((content): content is string => Boolean(content))
    .join(THREAD_SEGMENT_SEPARATOR);

  const showDocumentIcon = entry.kind === "document-comment";

  return (
    <div
      data-testid={`review-entry-chip-${entry.id}`}
      className={cn(
        "cursor-default group relative flex h-8 w-full items-center gap-0 overflow-hidden rounded-md border px-1",
        isCurrent ? "border-border bg-card" : "border-transparent",
        isResolved && "opacity-50",
      )}
      onClick={() => {
        onSelect?.();
        onOpenDialog?.();
      }}
    >
      {entry.kind === "suggestion" && (
        <div className="flex shrink-0 items-center gap-1 px-1 text-left">
          <span className="whitespace-nowrap text-sm leading-5 text-slate-700 dark:text-slate-300">
            {SUGGESTION_OPERATION_LABELS[entry.operation]}
          </span>
          <ReviewButton
            icon={Check}
            label="Accept suggestion"
            color="success"
            testId={`review-entry-chip-${entry.id}-action-accept`}
            onClick={() => onAcceptSuggestion?.(entry.id)}
          />
          <ReviewButton
            icon={X}
            label="Reject suggestion"
            color="danger"
            testId={`review-entry-chip-${entry.id}-action-reject`}
            onClick={() => onRejectSuggestion?.(entry.id)}
          />
        </div>
      )}
      <div className="flex items-center gap-1 px-1 text-left">
        {showDocumentIcon && (
          <FileText className="size-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
        )}
        <span className="shrink-0 whitespace-nowrap text-sm leading-5 text-slate-700 dark:text-slate-300">
          {commentCountLabel(commentCount)}
        </span>
      </div>
      <div className="truncate">{threadContent}</div>
      <ReviewButton
        icon={Trash2}
        label="Delete thread"
        color="danger"
        testId={`review-entry-chip-${entry.id}-action-delete`}
        onClick={() => onDeleteThread?.(entry.id)}
      />
    </div>
  );
}
