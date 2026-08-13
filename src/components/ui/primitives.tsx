import { ReactNode, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* Shared building blocks for the overhauled pages, so the token values in the
 * design are declared once rather than re-typed on every screen. */

/**
 * The "what does this actually do" affordance next to a setting's name.
 *
 * Opens on hover and on focus, and a click pins it open — a tooltip that only
 * answers to a hovering mouse is no answer at all for anyone driving the app
 * from the keyboard.
 */
export function Hint({ children, label }: { children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open || pinned} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`About ${label}`}
            onClick={() => setPinned((p) => !p)}
            onBlur={() => setPinned(false)}
            className={cn(
              "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full",
              "text-text-dim transition-colors duration-[120ms] hover:text-text-tertiary",
              (open || pinned) && "text-text-tertiary"
            )}
          >
            <HelpCircle size={13} strokeWidth={1.75} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="start">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex h-[62px] flex-shrink-0 items-center justify-between px-6">
      <div className="min-w-0">
        <h1 className="truncate text-h1 font-semibold text-text">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 truncate text-[12px] text-text-dim">{subtitle}</p>
        )}
      </div>
      {right}
    </header>
  );
}

/** h30 status pill — the "base · GPU" readout and the search field share it. */
export function Pill({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-[30px] items-center gap-2 rounded-[15px] border border-stroke-strong bg-input px-3 text-meta text-text-muted",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-card border border-stroke bg-card", className)}>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="section-label">{children}</span>;
}

/** Segmented control: trough + equal-height segments, as used for source and theme. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-[2px] rounded-tile border border-stroke-strong bg-input p-[3px]",
        className
      )}
      role="tablist"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center justify-center gap-[7px] rounded-segment transition-colors duration-[120ms]",
              size === "md" ? "h-[30px] px-[13px] text-label" : "h-[26px] px-3 text-[12px]",
              active
                ? "bg-segment-active font-medium text-text-strong shadow-segment"
                : "text-text-muted hover:text-text-tertiary"
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** 34×20 track, 14px knob, 3px inset. ON is accent-fill with a white knob. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-center gap-[9px]", disabled && "opacity-40")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-[34px] flex-shrink-0 rounded-full transition-colors duration-[120ms]",
          checked ? "bg-accent-fill" : "bg-track"
        )}
      >
        <span
          className={cn(
            "absolute top-[3px] h-3.5 w-3.5 rounded-full transition-all duration-[120ms]",
            checked ? "left-[17px] bg-white" : "left-[3px] bg-meter"
          )}
        />
      </button>
      {label && <span className="text-label text-text-muted">{label}</span>}
    </label>
  );
}

/**
 * h34 select — label left, value + chevron right.
 *
 * Deliberately not a native <select>. The popup a native select opens is drawn
 * by the platform, takes almost none of our styling, and in WebView2 came out
 * as unreadable default-on-dark. This renders its own menu so the list matches
 * the rest of the app.
 */
export function Select({
  label,
  value,
  onChange,
  options,
  minWidth,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  minWidth?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative" style={{ minWidth }}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={label || undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-[34px] w-full items-center gap-2 rounded-control border border-stroke-strong bg-input px-3 transition-colors duration-[120ms]",
          disabled ? "opacity-40" : "hover:border-stroke-strong hover:bg-fill-subtle"
        )}
      >
        {label && <span className="flex-shrink-0 text-[12px] text-text-dim">{label}</span>}
        <span className="ml-auto truncate text-[12.5px] text-text-secondary">
          {current?.label ?? value}
        </span>
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          className={cn(
            "flex-shrink-0 text-text-dim transition-transform duration-[120ms]",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-[38px] z-40 max-h-64 overflow-y-auto rounded-control border border-stroke-strong bg-card py-1 shadow-modal"
        >
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors duration-[120ms]",
                  selected
                    ? "bg-fill text-text-strong"
                    : "text-text-secondary hover:bg-fill-subtle"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {selected && (
                  <Check size={13} strokeWidth={1.75} className="flex-shrink-0 text-accent-ink" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** h36 filled primary. Always white on accent-fill. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  className,
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-9 items-center gap-2 rounded-control bg-accent-fill px-[18px] text-body font-semibold text-white transition-opacity duration-[120ms]",
        disabled ? "pointer-events-none opacity-40" : "hover:brightness-110",
        className
      )}
    >
      {children}
    </button>
  );
}

/** h32 secondary. */
export function SecondaryButton({
  children,
  onClick,
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-8 items-center gap-2 rounded-control border border-stroke-strong bg-fill-subtle px-3 text-[12.5px] font-medium text-text-secondary transition-colors duration-[120ms]",
        disabled ? "pointer-events-none opacity-40" : "hover:bg-fill-strong",
        className
      )}
    >
      {children}
    </button>
  );
}

/** Thin progress track — 3px by default, as used on job and download rows. */
export function Track({
  value,
  height = 3,
  className,
}: {
  value: number;
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("w-full overflow-hidden rounded-[2px] bg-track", className)}
      style={{ height }}
    >
      <div
        className="h-full rounded-[2px] bg-accent-ink transition-[width] duration-200 ease-linear"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}
