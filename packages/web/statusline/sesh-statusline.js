#!/usr/bin/env node
// Claude Code status line for sesh: prints "5h N% | 7d N%" and reports the plan usage to sesh.
// Plain Node, no dependencies. It posts to the sesh that Claude Code's OTel export already goes to
// (OTEL_EXPORTER_OTLP_ENDPOINT, with the bearer token in OTEL_EXPORTER_OTLP_HEADERS); SESH_URL and SESH_TOKEN
// override that. With neither it only prints the bar. It never fails or waits on the network: the post happens in
// a detached child.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const THROTTLE_MS = 60_000;
const POST_TIMEOUT_MS = 5_000;

const pct = (w) =>
  w && typeof w.used_percentage === "number" && Number.isFinite(w.used_percentage) ? w.used_percentage : null;
const resets = (w) => (w && typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at : null);

/** The part of the status line input sesh keeps: session id and the two windows. Null when there is nothing to report. */
export function parseInput(text, now = new Date()) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const limits = input.rate_limits ?? {};
  const snapshot = {
    session_id: typeof input.session_id === "string" ? input.session_id : null,
    five_hour_pct: pct(limits.five_hour),
    five_hour_resets_at: resets(limits.five_hour),
    seven_day_pct: pct(limits.seven_day),
    seven_day_resets_at: resets(limits.seven_day),
    captured_at: now.toISOString(),
  };
  return snapshot;
}

/** The bar Claude Code shows: `5h 19% | 7d 8%`, with `n/a` for a missing window. */
export function formatBar(snapshot) {
  const show = (v) => (v == null ? "n/a" : `${Math.round(v)}%`);
  return `5h ${show(snapshot?.five_hour_pct ?? null)} | 7d ${show(snapshot?.seven_day_pct ?? null)}`;
}

/** Whether this snapshot is worth posting: it has a session and at least one percentage. */
export const reportable = (s) => !!s && !!s.session_id && (s.five_hour_pct != null || s.seven_day_pct != null);

/** The bearer token in an OTLP headers value (`Authorization=Bearer <token>,other=...`, values may be %-encoded). */
function otlpBearer(headers) {
  for (const pair of (headers ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i < 0 || pair.slice(0, i).trim().toLowerCase() !== "authorization") continue;
    let value = pair.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // not %-encoded
    }
    const m = /^Bearer\s+(\S+)$/i.exec(value);
    if (m) return m[1];
  }
  return null;
}

/** Where to post and with what token: SESH_URL/SESH_TOKEN, else the OTel export's endpoint and token. Null for neither. */
export function target(env = process.env) {
  if (env.SESH_URL && env.SESH_TOKEN) return { url: new URL("/v1/limits", env.SESH_URL).href, token: env.SESH_TOKEN };
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const token = otlpBearer(env.OTEL_EXPORTER_OTLP_HEADERS);
  if (!endpoint || !token) return null;
  try {
    // Like OTLP's /v1/logs and /v1/metrics: appended to the endpoint, path and all.
    return { url: new URL(endpoint.replace(/\/+$/, "") + "/v1/limits").href, token };
  } catch {
    return null;
  }
}

async function postSnapshot(snapshot) {
  const to = target();
  if (!to) return;
  await fetch(to.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${to.token}` },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
}

/** True at most once a minute; remembers the last post in a file. Any file trouble just means "post". */
function throttled(now) {
  const file = join(process.env.SESH_STATE_DIR || join(homedir(), ".sesh"), "statusline-last-post");
  try {
    if (now - Number(readFileSync(file, "utf8")) < THROTTLE_MS) return true;
  } catch {
    // no state yet
  }
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, String(now));
  } catch {
    // cannot remember; post anyway
  }
  return false;
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main() {
  if (process.argv[2] === "--post") {
    // The detached child: the snapshot comes on stdin, errors are swallowed.
    try {
      await postSnapshot(JSON.parse(await readStdin()));
    } catch {
      // the server being down must not matter
    }
    return;
  }
  let snapshot = null;
  try {
    snapshot = parseInput(await readStdin());
  } catch {
    // unreadable input: print the empty bar
  }
  console.log(formatBar(snapshot));
  if (!reportable(snapshot) || !target() || throttled(Date.now())) return;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--post"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(snapshot));
    child.unref();
  } catch {
    // never break the status line
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {});
}
