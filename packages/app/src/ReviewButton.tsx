import type { LucideIcon } from "lucide-react";
import { cn } from "./lib/utils";

export type ReviewButtonColor = "neutral" | "success" | "danger";

const REVIEW_BUTTON_COLOR_CLASSES: Record<ReviewButtonColor, string> = {
  neutral:
    "text-stone-500 hover:bg-stone-100 focus-visible:ring-stone-300 dark:text-slate-400 dark:hover:bg-slate-700 dark:focus-visible:ring-slate-600",
  success:
    "text-emerald-600 hover:bg-emerald-50 focus-visible:ring-emerald-300 dark:text-emerald-500 dark:hover:bg-emerald-950 dark:focus-visible:ring-emerald-800",
  danger:
    "text-red-600 hover:bg-red-50 focus-visible:ring-red-300 dark:text-red-500 dark:hover:bg-red-950 dark:focus-visible:ring-red-800",
};

export interface ReviewButtonProps {
  icon: LucideIcon;
  label: string;
  color: ReviewButtonColor;
  testId?: string;
  onClick: () => void;
}

/**
 * The round icon-only button shared by every review action: open thread,
 * delete thread, accept suggestion, reject suggestion. Every call site stops
 * the click from bubbling to the entry it sits on top of, so that stays here
 * rather than repeated at each call site.
 */
export function ReviewButton({
  icon: Icon,
  label,
  color,
  testId,
  onClick,
}: ReviewButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      className={cn(
        "flex size-6 items-center justify-center ml-auto rounded-full transition focus:outline-none focus-visible:ring-2",
        REVIEW_BUTTON_COLOR_CLASSES[color],
      )}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon className="size-3.5" />
    </button>
  );
}
