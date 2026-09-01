import { useMemo } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface SuggestionComposerDraft {
  type: "insertion" | "replacement";
  sourceText: string;
  text: string;
}

interface SuggestionComposerPopoverProps {
  draft: SuggestionComposerDraft | null;
  anchorRect: DOMRect | null;
  onTextChange: (text: string) => void;
  onApply: () => void;
  onCancel: () => void;
}

export function SuggestionComposerPopover({
  draft,
  anchorRect,
  onTextChange,
  onApply,
  onCancel,
}: SuggestionComposerPopoverProps) {
  const anchor = useMemo(() => {
    if (!anchorRect) return null;

    return { getBoundingClientRect: () => anchorRect };
  }, [anchorRect]);

  const isOpen = draft !== null && anchor !== null;
  const canApply = draft !== null && draft.text.length > 0;

  return (
    <PopoverPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchor}
          side="right"
          sideOffset={8}
          align="start"
          className="isolate z-[70]"
        >
          <PopoverPrimitive.Popup
            data-testid="suggestion-composer"
            data-slot="popover-content"
            className={cn(
              "z-50 w-80 max-w-[calc(100vw-1.5rem)] origin-(--transform-origin) rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[ending-style]:animate-out data-[ending-style]:fade-out-0 data-[ending-style]:zoom-out-95 data-[starting-style]:animate-in data-[starting-style]:fade-in-0 data-[starting-style]:zoom-in-95",
            )}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
                return;
              }

              if (
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "enter"
              ) {
                event.preventDefault();
                if (canApply) onApply();
              }
            }}
          >
            {draft?.type === "replacement" ? (
              <div className="mb-2 rounded-md bg-stone-100 dark:bg-slate-800 px-2 py-1 text-xs leading-5 text-stone-600 dark:text-stone-400">
                {draft.sourceText}
              </div>
            ) : null}
            <Textarea
              data-testid="suggestion-composer-input"
              value={draft?.text ?? ""}
              rows={3}
              autoFocus
              placeholder={
                draft?.type === "replacement"
                  ? "Replacement text"
                  : "Inserted text"
              }
              onChange={(event) => onTextChange(event.target.value)}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                data-testid="suggestion-composer-action-cancel"
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="suggestion-composer-action-apply"
                disabled={!canApply}
                onClick={onApply}
              >
                Suggest
              </Button>
            </div>
            <PopoverPrimitive.Arrow className="z-50 size-2.5 rotate-45 rounded-[2px] border-t border-l border-border bg-popover data-[side=right]:left-0 data-[side=right]:-translate-x-1/2 data-[side=left]:right-0 data-[side=left]:translate-x-1/2" />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
