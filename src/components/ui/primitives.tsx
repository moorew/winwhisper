import { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/* Shared building blocks for the overhauled pages, so the token values in the
 * design are declared once rather than re-typed on every screen. */

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

/** h34 select styled as the design's control — label left, value + chevron right. */
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
  return (
    <div
      className={cn(
        "relative flex h-[34px] items-center gap-2 rounded-control border border-stroke-strong bg-input px-3",
        disabled && "opacity-40"
      )}
      style={{ minWidth }}
    >
      <span className="flex-shrink-0 text-[12px] text-text-dim">{label}</span>
      <span className="ml-auto truncate text-[12.5px] text-text-secondary">
        {options.find((o) => o.value === value)?.label ?? value}
      </span>
      <ChevronDown size={13} strokeWidth={1.75} className="flex-shrink-0 text-text-dim" />
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** h36 filled primary. Always white on accent-fill. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
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
