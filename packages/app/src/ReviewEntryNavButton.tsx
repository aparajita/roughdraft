import type { LucideIcon } from "lucide-react";
import { cn } from "./lib/utils";

interface ReviewEntryNavButtonProps {
  testId: string;
  ariaLabel: string;
  icon: LucideIcon;
  size: "sm" | "lg";
  disabled: boolean;
  onClick: () => void;
}

const SIZE_CLASSES: Record<ReviewEntryNavButtonProps["size"], string> = {
  sm: "size-6",
  lg: "size-8 shrink-0",
};

const ICON_SIZE_CLASSES: Record<ReviewEntryNavButtonProps["size"], string> = {
  sm: "size-3.5",
  lg: "size-5",
};

/** Circular chevron button shared by the review rail's nav control and the review footer. */
export function ReviewEntryNavButton({
  testId,
  ariaLabel,
  icon: Icon,
  size,
  disabled,
  onClick,
}: ReviewEntryNavButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        "flex items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 disabled:pointer-events-none disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-700 dark:focus-visible:ring-slate-600",
        SIZE_CLASSES[size],
      )}
      onClick={onClick}
    >
      <Icon className={ICON_SIZE_CLASSES[size]} />
    </button>
  );
}
