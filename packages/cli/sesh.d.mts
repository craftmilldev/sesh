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
  /** The transcript files the session spans (set by `scanSessions`). */
  files?: string[];
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
export function readSessionEntries(
  sessionId: string,
  env?: Record<string, string | undefined>,
  files?: string[] | null,
): TranscriptEntry[];
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
export interface SelectOptions {
  all?: boolean;
  since?: string | null;
  project?: string | null;
}
/** The sessions an upload covers: `all`, or those matching `since` (a date) and `project` (path substring). */
export function selectSessions(sessions: SessionSummary[], options?: SelectOptions): SessionSummary[];
/** The 0-based indexes picked by an answer like "all", "1,3" or "2-4" from a list of `max`, or null if it isn't one. */
export function parseChoice(answer: string, max: number): number[] | null;
export function uploadSummary(t: {
  sent: number;
  accepted: number;
  skipped: number;
  failed: number;
  events: number;
  unchanged?: number;
}): string;
/** A bulk upload's progress: done/total, time so far and time left. */
export function progressLine(done: number, total: number, elapsedMs: number): string;
/** Set on every metrics event: `product = sesh`, `app = sesh-cli`. */
export const IDENTITY: { readonly product: string; readonly app: string };
/** Whether metrics are off (DO_NOT_TRACK, or SESH_TELEMETRY=0). */
export function metricsOff(env?: Record<string, string | undefined>): boolean;
/** Records one PostHog event. Never throws; sends nothing when metrics are off. */
export function capture(
  event: string,
  properties?: Record<string, unknown>,
  options?: { env?: Record<string, string | undefined>; fetchFn?: typeof fetch },
): Promise<void>;
