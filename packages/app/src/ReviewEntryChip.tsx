import { Check, FileText, PencilLine, Trash2, X } from "lucide-react";
import type { ReviewEntry, SuggestionOperation } from "./document-comments";
import { cn } from "./lib/utils";
import { ReviewButton } from "./ReviewButton";

export interface ReviewEntryChipProps {
  entry: ReviewEntry | null;
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

function commentCountLabel(count: number): string {
  return count === 1 ? "1 comment" : `${count} comments`;
}

/**
 * One line, one entry: the shared summary rendered by both the review rail
 * and the narrow-width footer, so the two can never drift from each other.
 */
export function ReviewEntryChip({
  entry,
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
          No comments
        </span>
      </div>
    );
  }

  const commentCount = entry.commentIds.length;

  let label: string;
  let showCheckAndCross = false;
  const showDocumentIcon = entry.kind === "document-comment";

  switch (entry.kind) {
    case "document-comment":
    case "comment-thread": {
      label = commentCountLabel(commentCount);
      break;
    }
    case "suggestion": {
      const operationLabel = SUGGESTION_OPERATION_LABELS[entry.operation];
      label =
        commentCount > 0
          ? `${operationLabel} · ${commentCountLabel(commentCount)}`
          : operationLabel;
      showCheckAndCross = true;
      break;
    }
    default: {
      const exhaustiveCheck: never = entry;
      throw new Error(
        `Unhandled review entry kind: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }

  return (
    <div
      data-testid={`review-entry-chip-${entry.id}`}
      className={cn(
        "group relative flex h-8 w-full items-center gap-1.5 overflow-hidden rounded-md border px-1",
        isCurrent ? "border-border bg-card" : "border-transparent",
        isResolved && "opacity-50",
      )}
    >
      <button
        type="button"
        className="flex items-center gap-1 px-1 text-left"
        onClick={onSelect}
      >
        {showDocumentIcon && (
          <FileText className="size-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
        )}
        <span className="truncate whitespace-nowrap text-sm leading-5 text-slate-700 dark:text-slate-300">
          {label}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <ReviewButton
          icon={PencilLine}
          label="Open thread"
          color="neutral"
          testId={`review-entry-chip-${entry.id}-action-open`}
          onClick={() => onOpenDialog?.()}
        />
        {showCheckAndCross && entry.kind === "suggestion" && (
          <>
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
          </>
        )}
      </div>
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
