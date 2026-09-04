import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  normalizeCommentMeasurement,
  type ReviewEntry,
  resolveAnchoredRailLayouts,
} from "./document-comments";
import { cn } from "./lib/utils";
import { ReviewEntryChip } from "./ReviewEntryChip";
import { ReviewEntryNavButton } from "./ReviewEntryNavButton";
import type { ReviewComment } from "./review";

const RAIL_BOTTOM_PADDING = 24;

interface DocumentReviewRailProps {
  entries: ReviewEntry[];
  comments: ReadonlyMap<string, ReviewComment>;
  currentEntryId: string | null;
  resolvedEntryIds: ReadonlySet<string>;
  contentHeight: number;
  className?: string;
  testId?: string;
  onSelectEntry: (entryId: string) => void;
  onOpenDialog: (entryId: string) => void;
  onGoToPreviousEntry: () => void;
  onGoToNextEntry: () => void;
  onDeleteThread: (rootCommentId: string) => void;
  onAcceptSuggestion: (suggestionId: string) => void;
  onRejectSuggestion: (suggestionId: string) => void;
}

/** An entry whose place in the rail is the place of its anchor. */
type AnchoredReviewEntry = Extract<
  ReviewEntry,
  { kind: "comment-thread" | "suggestion" }
>;

/** An anchored entry as the stacking layout consumes it: keyed by entry id. */
interface AnchoredRailEntry {
  key: string;
  anchorTop: number;
  anchorBottom: number;
  entry: AnchoredReviewEntry;
}

function isAnchoredEntry(entry: ReviewEntry): entry is AnchoredReviewEntry {
  return entry.kind !== "document-comment";
}

/**
 * The review rail: the entry sequence rendered as one chip per entry, with a
 * navigation control at the top. The sequence itself is computed by `PageCard`
 * and arrives whole; the rail decides only where each chip sits.
 */
export function DocumentReviewRail({
  entries,
  comments,
  currentEntryId,
  resolvedEntryIds,
  contentHeight,
  className,
  testId = "document-review-rail",
  onSelectEntry,
  onOpenDialog,
  onGoToPreviousEntry,
  onGoToNextEntry,
  onDeleteThread,
  onAcceptSuggestion,
  onRejectSuggestion,
}: DocumentReviewRailProps) {
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [itemHeights, setItemHeights] = useState<Record<string, number>>({});

  const documentCommentEntries = useMemo(
    () => entries.filter((entry) => entry.kind === "document-comment"),
    [entries],
  );

  const anchoredEntries = useMemo<AnchoredRailEntry[]>(
    () =>
      entries.filter(isAnchoredEntry).map((entry) => ({
        key: entry.id,
        anchorTop: entry.anchorTop,
        anchorBottom: entry.anchorBottom,
        entry,
      })),
    [entries],
  );

  const layouts = useMemo(
    () =>
      resolveAnchoredRailLayouts(anchoredEntries, itemHeights, currentEntryId),
    [anchoredEntries, currentEntryId, itemHeights],
  );

  const setItemRef = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) {
      itemRefs.current.set(key, node);
    } else {
      itemRefs.current.delete(key);
    }
  }, []);

  useLayoutEffect(() => {
    if (layouts.length === 0) {
      setItemHeights((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
      return;
    }

    const updateHeights = () => {
      setItemHeights((current) => {
        const next: Record<string, number> = {};
        let changed = false;

        for (const layout of layouts) {
          const element = itemRefs.current.get(layout.key);
          const measuredHeight = Math.ceil(
            element?.getBoundingClientRect().height ?? 0,
          );
          const height =
            measuredHeight > 0
              ? Math.ceil(normalizeCommentMeasurement(measuredHeight, 1))
              : (current[layout.key] ?? 0);
          next[layout.key] = height;
          if (current[layout.key] !== height) {
            changed = true;
          }
        }

        if (
          !changed &&
          Object.keys(current).length === Object.keys(next).length
        ) {
          return current;
        }

        return next;
      });
    };

    updateHeights();

    const resizeObserver = new ResizeObserver(() => {
      updateHeights();
    });

    for (const layout of layouts) {
      const element = itemRefs.current.get(layout.key);
      if (element) {
        resizeObserver.observe(element);
      }
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [layouts]);

  const currentIndex = currentEntryId
    ? entries.findIndex((entry) => entry.id === currentEntryId)
    : -1;

  if (entries.length === 0) {
    return <aside className={cn("min-w-0", className)} aria-hidden="true" />;
  }

  const railHeight =
    Math.max(contentHeight, layouts.at(-1)?.railBottom ?? 0) +
    RAIL_BOTTOM_PADDING;

  const renderChip = (entry: ReviewEntry) => (
    <ReviewEntryChip
      entry={entry}
      comments={comments}
      isCurrent={entry.id === currentEntryId}
      isResolved={resolvedEntryIds.has(entry.id)}
      onSelect={() => onSelectEntry(entry.id)}
      onOpenDialog={() => onOpenDialog(entry.id)}
      onDeleteThread={onDeleteThread}
      onAcceptSuggestion={onAcceptSuggestion}
      onRejectSuggestion={onRejectSuggestion}
    />
  );

  return (
    <aside className={cn("min-w-0", className)} data-testid={testId}>
      <div
        data-testid="review-entry-nav"
        className="mb-2 flex items-center gap-1"
      >
        <span
          data-testid="review-entry-nav-position"
          className="text-xs tabular-nums text-stone-500 dark:text-stone-400"
        >
          {currentIndex >= 0
            ? `${currentIndex + 1} of ${entries.length}`
            : `${entries.length}`}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <ReviewEntryNavButton
            testId="review-entry-nav-action-previous"
            ariaLabel="Previous entry"
            icon={ChevronUp}
            size="sm"
            disabled={entries.length <= 1}
            onClick={onGoToPreviousEntry}
          />
          <ReviewEntryNavButton
            testId="review-entry-nav-action-next"
            ariaLabel="Next entry"
            icon={ChevronDown}
            size="sm"
            disabled={entries.length <= 1}
            onClick={onGoToNextEntry}
          />
        </div>
      </div>

      {documentCommentEntries.length > 0 && (
        <div className="mb-2 grid gap-1">
          {documentCommentEntries.map((entry) => (
            <div key={entry.id}>{renderChip(entry)}</div>
          ))}
        </div>
      )}

      <div className="relative" style={{ minHeight: railHeight }}>
        {layouts.map((layout) => (
          <div
            key={layout.key}
            ref={(node) => setItemRef(layout.key, node)}
            className="absolute left-0 right-0 transition-all duration-200 ease-out will-change-transform"
            style={{ top: layout.railTop }}
          >
            {renderChip(layout.entry)}
          </div>
        ))}
      </div>
    </aside>
  );
}
