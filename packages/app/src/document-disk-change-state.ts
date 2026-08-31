import type { DocumentSaveState } from "./PageCard";

export type DocumentDiskChangeState =
  | "clean"
  | "changed"
  | "conflict"
  | "paused";

export function shouldWarnBeforeUnload({
  activeDocumentPath,
  isDirty,
  saveState,
  diskChangeState,
}: {
  activeDocumentPath: string | null;
  isDirty: boolean;
  saveState: DocumentSaveState;
  diskChangeState: DocumentDiskChangeState;
}) {
  return (
    !!activeDocumentPath &&
    (isDirty ||
      saveState === "saving" ||
      saveState === "unsaved" ||
      saveState === "error" ||
      diskChangeState !== "clean")
  );
}
