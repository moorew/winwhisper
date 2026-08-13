import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Styled against the current token layer. The previous version asked for
 * `bg-popover` / `text-popover-foreground`, which the overhaul dropped from the
 * Tailwind colour map — the class names resolved to nothing, so the panel would
 * have rendered as unbacked text over whatever sat beneath it.
 */
export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-50 max-w-[280px] rounded-card border border-stroke-strong bg-card",
          "px-3 py-2 text-[12px] leading-[1.45] text-text-secondary shadow-lg shadow-black/30",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
