import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReviewEntry } from "./document-comments";
import { ReviewEntryChip } from "./ReviewEntryChip";
import { ReviewEntryNavButton } from "./ReviewEntryNavButton";

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
  const currentIndex = currentEntryId
    ? entries.findIndex((entry) => entry.id === currentEntryId)
    : -1;
  const entry =
    entries.length === 0
      ? null
      : currentIndex >= 0
        ? entries[currentIndex]
        : entries[0];
  const canNavigate = entries.length > 1;
  const displayIndex = currentIndex >= 0 ? currentIndex : 0;

  return (
    <div
      data-testid="review-entry-footer"
      className="review-entry-footer flex items-center gap-4 border-t border-border bg-card px-3"
    >
      <div className="flex items-center gap-1">
        <ReviewEntryNavButton
          testId="review-entry-footer-action-previous"
          ariaLabel="Previous entry"
          icon={ChevronLeft}
          size="lg"
          disabled={!canNavigate}
          onClick={onGoToPreviousEntry}
        />
        <ReviewEntryNavButton
          testId="review-entry-footer-action-next"
          ariaLabel="Next entry"
          icon={ChevronRight}
          size="lg"
          disabled={!canNavigate}
          onClick={onGoToNextEntry}
        />
      </div>
      {entries.length > 0 && (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {displayIndex + 1} of {entries.length}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <ReviewEntryChip
          entry={entry}
          isCurrent
          isResolved={entry ? resolvedEntryIds.has(entry.id) : false}
          onSelect={entry ? () => onSelectEntry(entry.id) : undefined}
          onOpenDialog={entry ? () => onOpenDialog(entry.id) : undefined}
          onDeleteThread={entry ? onDeleteThread : undefined}
          onAcceptSuggestion={entry ? onAcceptSuggestion : undefined}
          onRejectSuggestion={entry ? onRejectSuggestion : undefined}
        />
      </div>
    </div>
  );
}
