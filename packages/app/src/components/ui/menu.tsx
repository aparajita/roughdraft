import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "@/lib/utils";

function Menu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />;
}

function MenuTrigger({ className, ...props }: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger
      data-slot="menu-trigger"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-stone-400 dark:text-stone-500 outline-none transition-colors duration-150 hover:bg-[#DED8CE]/45 hover:text-stone-600 dark:hover:bg-slate-700 dark:hover:text-stone-300 focus-visible:ring-2 focus-visible:ring-stone-300/70 dark:focus-visible:ring-slate-600/70 data-[popup-open]:bg-[#DED8CE]/45 dark:data-[popup-open]:bg-slate-700 data-[popup-open]:text-stone-600 dark:data-[popup-open]:text-stone-300",
        className,
      )}
      {...props}
    />
  );
}

function MenuContent({
  className,
  side = "bottom",
  sideOffset = 5,
  align = "end",
  alignOffset = 0,
  children,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-[70]"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            "min-w-32 origin-(--transform-origin) rounded-lg border border-[#DCD6CC] dark:border-slate-700 bg-[#FFFDFC] dark:bg-slate-800 p-1 text-xs text-stone-700 dark:text-stone-300 shadow-[0_12px_32px_rgba(57,47,38,0.16)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.4)] outline-none data-[ending-style]:animate-out data-[ending-style]:fade-out-0 data-[ending-style]:zoom-out-95 data-[starting-style]:animate-in data-[starting-style]:fade-in-0 data-[starting-style]:zoom-in-95",
            className,
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[0.72rem] leading-none outline-none transition select-none data-[highlighted]:bg-[#EEE9E1] dark:data-[highlighted]:bg-slate-700 data-[highlighted]:text-stone-900 dark:data-[highlighted]:text-stone-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn("my-1 h-px bg-[#DCD6CC] dark:bg-slate-700", className)}
      {...props}
    />
  );
}

export { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger };
