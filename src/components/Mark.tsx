/**
 * The WinWhisper mark: three flat rounded bars, a symmetrical voice peak.
 *
 * Drawn on a 32×32 grid — bar width 6, gap 5, radius 3 (half the width, so the
 * caps are full pills), heights 16 / 26 / 16. That is a 28×26 footprint centred
 * in the box, which is why the outer bars sit at x=2 and x=24.
 *
 * Flat only: no gradient, bevel, inner highlight or shadow on the mark itself.
 * It stays legible down to 16px, which is why a three-bar mark was chosen.
 */
export function Mark({
  size = 32,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <rect x="2" y="8" width="6" height="16" rx="3" fill="currentColor" />
      <rect x="13" y="3" width="6" height="26" rx="3" fill="currentColor" />
      <rect x="24" y="8" width="6" height="16" rx="3" fill="currentColor" />
    </svg>
  );
}

/**
 * The mark on its accent tile — the app-icon lockup, used in the first-run
 * modal and anywhere the product needs to introduce itself. Tile radius scales
 * with size (34 @176, 13 @64/52, 7 @32) and the mark occupies ~62.5% of it.
 */
export function MarkTile({
  size = 52,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const radius = size >= 120 ? size * 0.193 : size >= 44 ? size * 0.203 : size * 0.219;
  return (
    <div
      className={`flex flex-shrink-0 items-center justify-center bg-accent-fill text-white ${className ?? ""}`}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <Mark size={size * 0.625} />
    </div>
  );
}
