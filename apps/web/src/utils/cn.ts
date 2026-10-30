// ── Utility function for className merging ───────────────────────────────
// Combines class names using clsx/tailwind-merge pattern

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
