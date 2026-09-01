import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReviewEntry } from "./document-comments";
import { ReviewEntryChip } from "./ReviewEntryChip";

interface ReviewEntryFooterProps {
  entries: ReviewEntry[];
  currentEntryId: string | null;
  resolvedEntryIds: ReadonlySet<string>;
  onSelectEntry: (entryId: string) => void;
  onOpenDialog: (entryId: string) => void;
  onGoToPreviousEntry: () => void;
  onGoToNextEntry: () => void;
  onDeleteThread: (rootCommentId: string) => void;
  onAcceptSuggestion: (suggestionId: string) => void;
  onRejectSuggestion: (suggestionId: string) => void;
}

/**
 * Fixed bar shown below `--breakpoint-rail`, summarizing the current review
 * entry in the same terms as its rail chip and offering the same
 * previous/next navigation as the rail's nav control.
 */
export function ReviewEntryFooter({
  entries,
  currentEntryId,
  resolvedEntryIds,
  onSelectEntry,
  onOpenDialog,
  onGoToPreviousEntry,
  onGoToNextEntry,
  onDeleteThread,
  onAcceptSuggestion,
  onRejectSuggestion,
}: ReviewEntryFooterProps) {
  if (entries.length === 0) {
    return null;
  }

  const currentIndex = currentEntryId
    ? entries.findIndex((entry) => entry.id === currentEntryId)
    : -1;
  const entry = currentIndex >= 0 ? entries[currentIndex] : entries[0];
  const index = currentIndex >= 0 ? currentIndex : 0;

  return (
    <div
      data-testid="review-entry-footer"
      className="review-entry-footer flex items-center gap-2 border-t border-border bg-card px-3"
    >
      <button
        type="button"
        data-testid="review-entry-footer-action-previous"
        aria-label="Previous entry"
        disabled={index === 0}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 disabled:pointer-events-none disabled:opacity-40 dark:text-stone-400 dark:hover:bg-slate-700 dark:focus-visible:ring-slate-600"
        onClick={onGoToPreviousEntry}
      >
        <ChevronLeft className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <ReviewEntryChip
          entry={entry}
          isCurrent
          isResolved={resolvedEntryIds.has(entry.id)}
          onSelect={() => onSelectEntry(entry.id)}
          onOpenDialog={() => onOpenDialog(entry.id)}
          onDeleteThread={onDeleteThread}
          onAcceptSuggestion={onAcceptSuggestion}
          onRejectSuggestion={onRejectSuggestion}
        />
      </div>
      <button
        type="button"
        data-testid="review-entry-footer-action-next"
        aria-label="Next entry"
        disabled={index === entries.length - 1}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 disabled:pointer-events-none disabled:opacity-40 dark:text-stone-400 dark:hover:bg-slate-700 dark:focus-visible:ring-slate-600"
        onClick={onGoToNextEntry}
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
