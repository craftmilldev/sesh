/** Number formatting shared by the pages. */

export const num = (n: number) => n.toLocaleString("en-US");

/** 51_700_000 -> "51.7M", 3_400 -> "3.4K", 12 -> "12". */
export function abbreviate(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** Part of the total, one decimal ("97.7%"); a dash when there is no total. */
export const share = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "–");

export const clock = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
