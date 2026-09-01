import { Check, PencilLine, X } from "lucide-react";
import type { ReviewEntry, SuggestionOperation } from "./document-comments";
import { cn } from "./lib/utils";

export interface ReviewEntryChipProps {
  entry: ReviewEntry;
  isCurrent: boolean;
  isResolved: boolean;
  onSelect: () => void;
  onOpenDialog: () => void;
  onAcceptSuggestion: (suggestionId: string) => void;
  onRejectSuggestion: (suggestionId: string) => void;
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
  onAcceptSuggestion,
  onRejectSuggestion,
}: ReviewEntryChipProps) {
  const commentCount = entry.commentIds.length;

  let label: string;
  let showCheckAndCross = false;

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
        "group relative flex h-8 w-full items-center gap-1.5 overflow-hidden rounded-md border px-2",
        isCurrent ? "border-border bg-card" : "border-transparent",
        isResolved && "opacity-50",
      )}
    >
      <button
        type="button"
        className="absolute inset-0 flex items-center px-2 text-left"
        onClick={onSelect}
      >
        <span className="truncate whitespace-nowrap text-sm leading-5 text-slate-700 dark:text-slate-300">
          {label}
        </span>
      </button>
      <div className="relative ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          data-testid={`review-entry-chip-${entry.id}-action-open`}
          aria-label="Open thread"
          className="flex size-6 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:text-stone-400 dark:hover:bg-slate-700 dark:focus-visible:ring-slate-600"
          onClick={(event) => {
            event.stopPropagation();
            onOpenDialog();
          }}
        >
          <PencilLine className="size-3.5" />
        </button>
        {showCheckAndCross && entry.kind === "suggestion" && (
          <>
            <button
              type="button"
              data-testid={`review-entry-chip-${entry.id}-action-accept`}
              aria-label="Accept suggestion"
              className="flex size-6 items-center justify-center rounded-full text-emerald-600 transition hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 dark:text-emerald-500 dark:hover:bg-emerald-950 dark:focus-visible:ring-emerald-800"
              onClick={(event) => {
                event.stopPropagation();
                onAcceptSuggestion(entry.id);
              }}
            >
              <Check className="size-3.5" />
            </button>
            <button
              type="button"
              data-testid={`review-entry-chip-${entry.id}-action-reject`}
              aria-label="Reject suggestion"
              className="flex size-6 items-center justify-center rounded-full text-red-600 transition hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 dark:text-red-500 dark:hover:bg-red-950 dark:focus-visible:ring-red-800"
              onClick={(event) => {
                event.stopPropagation();
                onRejectSuggestion(entry.id);
              }}
            >
              <X className="size-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
