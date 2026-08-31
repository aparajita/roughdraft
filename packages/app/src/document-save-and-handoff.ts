import type { DocumentDiskChangeState } from "./document-disk-change-state";
import type { DocumentSaveState } from "./PageCard";

export type ReviewHandoffState =
  | "idle"
  | "notifying"
  | "notified"
  | "undelivered"
  | "error";

export function isDocumentSaveBlocked(
  diskChangeState: DocumentDiskChangeState,
): diskChangeState is Exclude<DocumentDiskChangeState, "clean"> {
  // While the file on disk diverges, the conflict banner owns the resolution
  // and nothing may write over it — autosave and the manual-save shortcut
  // alike.
  return diskChangeState !== "clean";
}

export function isReviewHandoffDisabled({
  saveState,
  documentDiskChangeState,
  reviewHandoffState,
}: {
  saveState: DocumentSaveState;
  documentDiskChangeState: DocumentDiskChangeState;
  reviewHandoffState: ReviewHandoffState;
}) {
  // A pending debounced save ("saving") intentionally does NOT disable the
  // button. Disabling on it dims the whole control on every keystroke while
  // autosave debounces. Instead the button stays enabled and flushes the
  // pending save on click, so the agent still receives the latest content.
  return (
    saveState === "error" ||
    reviewHandoffState !== "idle" ||
    isDocumentSaveBlocked(documentDiskChangeState)
  );
}

export function getReviewHandoffButtonLabel({
  reviewHandoffState,
  documentChangedSinceOpen,
}: {
  reviewHandoffState: ReviewHandoffState;
  documentChangedSinceOpen: boolean;
}) {
  return reviewHandoffState === "notifying"
    ? "Sending"
    : reviewHandoffState === "notified"
      ? "Sent"
      : reviewHandoffState === "error" || reviewHandoffState === "undelivered"
        ? "Not sent"
        : documentChangedSinceOpen
          ? "I'm done"
          : "Approve";
}

export function shouldLatchDocumentChangedSinceOpen({
  isDirty,
  documentChangeTrackingReady,
}: {
  isDirty: boolean;
  documentChangeTrackingReady: boolean;
}) {
  return isDirty && documentChangeTrackingReady;
}
