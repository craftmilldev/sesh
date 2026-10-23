export interface Snapshot {
  session_id: string | null;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_pct: number | null;
  seven_day_resets_at: number | null;
  captured_at: string;
}
export function parseInput(text: string, now?: Date): Snapshot | null;
export function formatBar(snapshot: Snapshot | null): string;
export function reportable(snapshot: Snapshot | null): boolean;
/** Where the status line posts, from SESH_URL/SESH_TOKEN or else the OTel export settings. Null when neither is set. */
export function target(env?: Record<string, string | undefined>): { url: string; token: string } | null;
