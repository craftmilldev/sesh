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
export interface Target {
  url: string;
  token: string;
}
/** Where the status line posts: SESH_URL/SESH_TOKEN, else config.json, else the OTel export settings. Null for none. */
export function target(env?: Record<string, string | undefined>, config?: Target | null): Target | null;
/** The `{ url, token }` saved in config.json next to the script (or `file`), or null when missing or unreadable. */
export function readConfig(file?: string | URL): Target | null;
