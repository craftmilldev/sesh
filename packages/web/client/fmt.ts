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

/** Midnight at the start of the viewer's local day. */
export function localMidnight(d = new Date()): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m;
}

/** The start of the next local day (not midnight + 24h, so a clock change cannot shift it). */
export function nextLocalMidnight(d: Date): Date {
  const m = localMidnight(d);
  m.setDate(m.getDate() + 1);
  return m;
}
