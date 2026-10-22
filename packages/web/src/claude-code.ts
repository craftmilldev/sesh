import { gunzipSync } from "node:zlib";
import { sha256 } from "./ids.js";

/** One Claude Code log record, reduced to the agent-neutral shape sesh stores. */
export type ParsedRecord =
  | { type: "prompt"; sessionId: string; promptId: string; at: Date; promptLength?: number }
  | {
      type: "event";
      sessionId: string;
      promptId?: string;
      /** Stable per record, so parsing the same payload twice (or an overlapping one) adds nothing. */
      dedupeKey: string;
      kind: "api_request" | "tool_call";
      at: Date;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      durationMs?: number;
      toolName?: string;
      success?: boolean;
      raw: Record<string, unknown>;
    };

type Attrs = Record<string, string | number | boolean>;

/**
 * The only attributes kept in an event's raw JSON. Anything else can carry what the user typed or worked on
 * (the prompt, tool parameters and inputs, file paths, error text) or who they are (`user.*`), so it never reaches the database.
 */
const KEPT_ATTRS = new Set([
  "event.name",
  "event.timestamp",
  "event.sequence",
  "session.id",
  "prompt.id",
  "terminal.type",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cost_usd",
  "duration_ms",
  "tool_name",
  "success",
]);

function anyValue(v: Record<string, unknown> | undefined): string | number | boolean | undefined {
  if (!v) return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.doubleValue === "number") return v.doubleValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  return undefined;
}

function attrsOf(list: unknown): Attrs {
  const out: Attrs = {};
  if (!Array.isArray(list)) return out;
  for (const a of list as { key?: string; value?: Record<string, unknown> }[]) {
    const v = anyValue(a.value);
    // Postgres text and jsonb can't hold a NUL.
    if (typeof a.key === "string" && v !== undefined) out[a.key] = typeof v === "string" ? v.replaceAll("\0", "") : v;
  }
  return out;
}

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** The body of a stored payload as JSON, or undefined when it isn't JSON we can read (protobuf). */
export function decodeJsonPayload(body: Uint8Array, contentType: string, contentEncoding?: string | null) {
  if (contentType !== "application/json") return undefined;
  try {
    const bytes = contentEncoding === "gzip" ? gunzipSync(body) : body;
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads an OTLP/JSON logs export from Claude Code. Records are `user_prompt`, `api_request` and `tool_result` events
 * (named in the `event.name` attribute, with or without a `claude_code.` prefix); everything else is ignored.
 * Records without a `session.id` can't be placed and are skipped. Prompt text is dropped here, before anything is stored.
 */
export function parseClaudeCodeLogs(payload: unknown): ParsedRecord[] {
  const out: ParsedRecord[] = [];
  const resources = (payload as { resourceLogs?: unknown[] } | null)?.resourceLogs;
  if (!Array.isArray(resources)) return out;
  for (const rl of resources as { scopeLogs?: { logRecords?: unknown[] }[] }[]) {
    for (const scope of rl.scopeLogs ?? []) {
      for (const rec of (scope.logRecords ?? []) as Record<string, unknown>[]) {
        const attrs = attrsOf(rec.attributes);
        const name = (str(attrs["event.name"]) ?? str(anyValue(rec.body as Record<string, unknown>)) ?? "").replace(
          /^claude_code\./,
          "",
        );
        const sessionId = str(attrs["session.id"]);
        if (!sessionId) continue;
        const nano = num(rec.timeUnixNano);
        const stamp = str(attrs["event.timestamp"]);
        const at = stamp ? new Date(stamp) : nano ? new Date(Math.floor(nano / 1e6)) : new Date(NaN);
        if (Number.isNaN(at.getTime())) continue;
        const promptId = str(attrs["prompt.id"]);

        if (name === "user_prompt") {
          if (promptId) out.push({ type: "prompt", sessionId, promptId, at, promptLength: num(attrs.prompt_length) });
          continue;
        }
        if (name !== "api_request" && name !== "tool_result") continue;

        const raw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(attrs)) if (KEPT_ATTRS.has(k)) raw[k] = v;
        const seq = num(attrs["event.sequence"]);
        out.push({
          type: "event",
          sessionId,
          promptId,
          dedupeKey: seq !== undefined ? `${name}:${seq}` : `${name}:h:${sha256(JSON.stringify(raw))}`,
          kind: name === "api_request" ? "api_request" : "tool_call",
          at,
          model: str(attrs.model),
          inputTokens: num(attrs.input_tokens),
          outputTokens: num(attrs.output_tokens),
          cacheReadTokens: num(attrs.cache_read_tokens),
          cacheWriteTokens: num(attrs.cache_creation_tokens),
          costUsd: num(attrs.cost_usd),
          durationMs: num(attrs.duration_ms),
          toolName: str(attrs.tool_name),
          success: bool(attrs.success),
          raw,
        });
      }
    }
  }
  return out;
}
