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
export const VERSION: string;
/** The server the CLI reports to and updates from, as an origin. */
export function serverOrigin(env?: Record<string, string | undefined>, config?: Target | null): string;
/** Whether this copy updates itself: the installed ~/.sesh/sesh.mjs, with updates not turned off. */
export function updatesEnabled(
  env?: Record<string, string | undefined>,
  self?: string,
  raw?: { auto_update?: boolean },
): boolean;
/** Whether a status line command is sesh's. */
export function isSeshCommand(command: string): boolean;
export function main(argv: string[]): Promise<void>;
/** The version of a `cli-v<x.y.z>` release tag, or undefined for any other tag. */
export function releaseVersion(tag: string): string | undefined;
/** Whether version `a` is newer than `b`; both are x.y.z. */
export function isNewer(a: string, b: string): boolean;
export interface SessionSummary {
  id: string;
  started_at: string | null;
  project: string | null;
  prompts: number;
  tokens: number;
}
/** What one transcript says about its session, or null when it has no entries. Never includes prompt text. */
export function parseTranscript(text: string, fallbackId?: string | null): SessionSummary | null;
/** The sessions in Claude Code's transcripts under CLAUDE_CONFIG_DIR (or ~/.claude), newest first. */
export function scanSessions(env?: Record<string, string | undefined>): SessionSummary[];
export type TranscriptEntry = Record<string, unknown>;
export interface TurnRecord {
  name: "user_prompt" | "api_request" | "tool_result";
  at: number;
  attrs: Record<string, string | number | boolean>;
}
export interface Turn {
  promptId: string;
  records: TurnRecord[];
}
/** Every entry of one session across its transcripts, oldest first, each with `_at` (ms). */
export function readSessionEntries(sessionId: string, env?: Record<string, string | undefined>): TranscriptEntry[];
/** The turns of a session as the events Claude Code would have logged live. Never includes prompt text. */
export function buildTurns(entries: TranscriptEntry[], sessionId: string): Turn[];
/** OTLP/JSON logs payloads (`sesh.source=backfill`), each under `maxBytes`, broken between turns only. */
export function buildPayloads(
  turns: Turn[],
  sessionId: string,
  maxBytes?: number,
): { payloads: Record<string, unknown>[]; events: number; dropped: number };
/** Where upload posts: the configured server's /v1/logs. */
export function logsUrl(to: Target | null): string | null;
