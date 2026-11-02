#!/usr/bin/env node
// sesh: the command line for sesh (session insights for Claude Code teams), and the Claude Code status line that
// reports plan usage to it. Plain Node 22+, no dependencies, one file: install.sh puts a GitHub release's
// sesh.mjs at ~/.sesh/sesh.mjs, and an installed copy keeps itself current from the repo's releases.
//
//   sesh status              what is set up: server, token, status line, last reading, updates
//   sesh sessions            list the Claude Code sessions on this machine (reads local files only)
//   sesh upload <session>    send one past session to sesh as OTel logs (--dry-run prints them and sends nothing)
//   sesh setup               save the server and token, and make sesh Claude Code's status line
//   sesh statusline [on|off] with no argument: the status line itself (what Claude Code runs); on/off: manage it
//   sesh config [set k v]    show the settings, or change url, token or auto_update
//   sesh update              install the newest version now
//
// The status line posts to the sesh in config.json next to this file (`{ "url", "token" }`, which `sesh setup`
// writes from the OTel export settings, since Claude Code passes no OTEL_* variables to the status line). SESH_URL
// and SESH_TOKEN override that; the OTel variables are the last resort. It never fails or waits on the network: the
// post, and any update, happen in a detached child.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
const DEFAULT_SERVER = "https://sesh.craftmill.dev";
const THROTTLE_MS = 60_000;
const POST_TIMEOUT_MS = 5_000;
/** How long a lookup of the server's newest CLI is trusted, so commands and status line refreshes don't each make one. */
const CHECK_TTL_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 3_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Set on the process a self-update starts, so it doesn't update again before running the command. */
const UPDATED_ENV = "SESH_UPDATED";

const SELF = fileURLToPath(import.meta.url);
const stateDir = (env = process.env) => env.SESH_STATE_DIR || join(homedir(), ".sesh");
const settingsPath = (env = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");

// --- product metrics ---------------------------------------------------------------------------------------------

/** Craftmill's PostHog project key. Project keys are write-only and public by design; POSTHOG_API_KEY overrides it. */
const POSTHOG_KEY = "phc_BPP9dYnbUgCbhLiRynBT4sEpWJaYAFWMVApuMZUshQMy";
/** Craftmill's shared PostHog proxy (it forwards /i/v0/e/ to PostHog). */
const POSTHOG_HOST = "https://a.craftmill.dev/api/ingest";
const METRICS_TIMEOUT_MS = 2_000;
/** Set on every event so reports can filter on `product = sesh` (`app` says which part of Sesh sent it). */
export const IDENTITY = { product: "sesh", app: "sesh-cli" };
/** Extra properties the running command wants on its outcome event (counts, never contents). */
const outcomeProps = {};

/** Whether metrics are off: DO_NOT_TRACK or SESH_TELEMETRY=0. */
export const metricsOff = (env = process.env) =>
  (!!env.DO_NOT_TRACK && env.DO_NOT_TRACK !== "0") || env.SESH_TELEMETRY === "0";

/** The random id that stands for this install: ~/.sesh/install-id, made on first use. */
function installId(env = process.env) {
  const file = join(stateDir(env), "install-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    // no id yet
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, id + "\n", { mode: 0o600 });
  } catch {
    // cannot remember it; this event just gets a one-off id
  }
  return id;
}

/** Records one event, right away (the CLI exits as soon as its command is done). Never throws, never waits long. */
export async function capture(event, properties = {}, { env = process.env, fetchFn = fetch } = {}) {
  if (metricsOff(env)) return;
  try {
    await fetchFn(`${env.POSTHOG_HOST || POSTHOG_HOST}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_API_KEY || POSTHOG_KEY,
        event,
        distinct_id: installId(env),
        properties: { ...properties, ...IDENTITY, cli_version: VERSION, $process_person_profile: false },
      }),
      signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
    });
  } catch {
    // offline or blocked: the command still has to work
  }
}

/** The commands whose use is counted. The status line runs constantly, and the local-only ones (sessions, config,
 * upload --dry-run) make no request, so they are left out. */
const COUNTED = new Set(["status", "upload", "setup", "update", "statusline"]);

/** Runs a command and records how it ended: `cli_command_succeeded` or `cli_command_failed`, with the command name. */
async function counted(command, quiet, run) {
  if (!COUNTED.has(command) || quiet) return run();
  const started = Date.now();
  const done = (outcome) =>
    capture(`cli_command_${outcome}`, { command, duration_ms: Date.now() - started, ...outcomeProps });
  try {
    await run();
  } catch (err) {
    await done("failed");
    throw err;
  }
  await done(process.exitCode ? "failed" : "succeeded");
}

// --- the status line -------------------------------------------------------------------------------------------

const pct = (w) =>
  w && typeof w.used_percentage === "number" && Number.isFinite(w.used_percentage) ? w.used_percentage : null;
const resets = (w) => (w && typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at : null);

/** The part of the status line input sesh keeps: session id and the two windows. Null when it isn't JSON. */
export function parseInput(text, now = new Date()) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const limits = input.rate_limits ?? {};
  return {
    session_id: typeof input.session_id === "string" ? input.session_id : null,
    five_hour_pct: pct(limits.five_hour),
    five_hour_resets_at: resets(limits.five_hour),
    seven_day_pct: pct(limits.seven_day),
    seven_day_resets_at: resets(limits.seven_day),
    captured_at: now.toISOString(),
  };
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

/** Where to post and with what token: SESH_URL/SESH_TOKEN, else config.json, else the OTel export's. Null for none. */
export function target(env = process.env, config = readConfig()) {
  if (env.SESH_URL && env.SESH_TOKEN) return { url: new URL("/v1/limits", env.SESH_URL).href, token: env.SESH_TOKEN };
  if (config) return config;
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

/** The `{ url, token }` saved in config.json next to this file (or `file`), or null when there is none or it is unreadable. */
export function readConfig(file = new URL("./config.json", import.meta.url)) {
  const raw = readRawConfig(file);
  if (typeof raw.url === "string" && typeof raw.token === "string" && raw.token) {
    try {
      return { url: new URL(raw.url).href, token: raw.token };
    } catch {
      // not a URL
    }
  }
  return null;
}

/** config.json as it is, so settings other than the target (auto_update) survive a change to one of them. */
function readRawConfig(file = new URL("./config.json", import.meta.url)) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeConfig(raw, file = join(dirname(SELF), "config.json")) {
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, raw, 0o600);
}

function writeJsonAtomic(file, value, mode = 0o644) {
  const tmp = `${file}.sesh-tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(tmp, file);
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
  const file = join(stateDir(), "statusline-last-post");
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

/**
 * What Claude Code runs. Prints the bar, then hands the rest to a detached child so nothing here waits on the
 * network: the post (at most once a minute) and the update check (at most every ten minutes, installing quietly).
 */
async function runStatusline() {
  let snapshot = null;
  try {
    snapshot = parseInput(await readStdin());
  } catch {
    // unreadable input: print the empty bar
  }
  console.log(formatBar(snapshot));
  try {
    const post = reportable(snapshot) && !!target() && !throttled(Date.now());
    if (post) saveLastReading(snapshot);
    const check = updatesEnabled() && lookupDue();
    if (!post && !check) return;
    const child = spawn(process.execPath, [SELF, "statusline", "--background"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(post ? snapshot : null));
    child.unref();
  } catch {
    // never break the status line
  }
}

/** The detached child: the snapshot to post (or null) comes on stdin; every error is swallowed. */
async function runBackground() {
  try {
    const snapshot = JSON.parse(await readStdin());
    if (snapshot) await postSnapshot(snapshot);
  } catch {
    // the server being down must not matter
  }
  try {
    if (updatesEnabled()) {
      const latest = await latestCli({});
      if (newerThanThis(latest)) await installUpdate(latest);
    }
  } catch {
    // an update that fails is tried again at the next check
  }
}

function saveLastReading(snapshot) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeJsonAtomic(join(stateDir(), "statusline-last.json"), snapshot);
  } catch {
    // only `sesh status` reads it
  }
}

// --- updates ---------------------------------------------------------------------------------------------------

const REPO = "craftmilldev/sesh";
// Releases come from GitHub (the repo is public), as loopway's do; tests point these at a local server.
const apiUrl = (env = process.env) => env.SESH_API_URL || "https://api.github.com";
const downloadUrl = (env = process.env) => env.SESH_DOWNLOAD_URL || "https://github.com";

/** The version of the tag `cli-v<x.y.z>`, or undefined for any other tag. */
export const releaseVersion = (tag) => /^cli-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];

/** Whether version `a` is newer than `b`; both are x.y.z. */
export function isNewer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The server the CLI reports to: the one in config.json or SESH_URL, else sesh's own. */
export function serverOrigin(env = process.env, config = target(env)) {
  try {
    return new URL(config?.url ?? env.SESH_URL ?? DEFAULT_SERVER).origin;
  } catch {
    return DEFAULT_SERVER;
  }
}

/**
 * Whether this copy updates itself: it is the installed one (~/.sesh/sesh.mjs, not a git checkout), and updates are
 * not turned off (SESH_NO_UPDATE, or auto_update false in config.json).
 */
export function updatesEnabled(env = process.env, self = SELF, raw = readRawConfig()) {
  return sameFile(self, join(stateDir(env), "sesh.mjs")) && !env.SESH_NO_UPDATE && raw.auto_update !== false;
}

/** Whether two paths are the same file, through symlinks (the `sesh` command is one). */
function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function readCheck() {
  try {
    const c = JSON.parse(readFileSync(join(stateDir(), "update-check.json"), "utf8"));
    if (typeof c.checked_at === "number") return c;
  } catch {
    // no lookup yet
  }
  return null;
}

const lookupDue = (now = Date.now()) => {
  const c = readCheck();
  return !c || now - c.checked_at >= CHECK_TTL_MS;
};

/**
 * The newest release's version (`{ version }`), from GitHub or (within ten minutes of the last lookup) from
 * ~/.sesh/update-check.json. Null when it can't be found (offline, rate limited); a failed lookup is remembered
 * as long as a good one, so an offline machine doesn't wait on it every command.
 */
async function latestCli({ force = false, fetchFn = fetch, now = Date.now() }) {
  const cached = readCheck();
  if (!force && cached && now - cached.checked_at < CHECK_TTL_MS) return cached.latest ?? null;
  let latest = null;
  try {
    // The repo's latest release is the CLI's only while release-cli.yml is the one thing that publishes releases here.
    const res = await fetchFn(`${apiUrl()}/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sesh-cli" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.ok) {
      const version = releaseVersion((await res.json()).tag_name ?? "");
      if (version) latest = { version };
    }
  } catch {
    // offline or slow
  }
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeJsonAtomic(join(stateDir(), "update-check.json"), { checked_at: now, latest });
  } catch {
    // the next command looks again
  }
  return latest;
}

const newerThanThis = (latest) => !!latest && isNewer(latest.version, VERSION);

/** Downloads release `latest` and puts it over this file if it runs and reports that version. */
async function installUpdate(latest, fetchFn = fetch) {
  const res = await fetchFn(`${downloadUrl()}/${REPO}/releases/download/cli-v${latest.version}/sesh.mjs`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`could not download the new version (${res.status})`);
  const tmp = join(dirname(SELF), `.sesh.${process.pid}.mjs`);
  try {
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    // A bad file must not replace a working one.
    const run = spawnSync(process.execPath, [tmp, "--version"], { encoding: "utf8", timeout: 10_000 });
    if (run.status !== 0 || run.stdout.trim() !== latest.version) {
      throw new Error(`the download isn't sesh ${latest.version}`);
    }
    chmodSync(tmp, 0o755);
    renameSync(tmp, SELF);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Before a command: installs a newer version if there is one, and runs the command again on it. Never blocks a command. */
async function updateBeforeCommand(argv) {
  if (process.env[UPDATED_ENV] || !updatesEnabled()) return;
  try {
    const latest = await latestCli({});
    if (!newerThanThis(latest)) return;
    console.error(`Updating sesh ${VERSION} → ${latest.version}…`);
    await installUpdate(latest);
  } catch (err) {
    console.error(`Could not update sesh: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const res = spawnSync(process.execPath, [SELF, ...argv], {
    stdio: "inherit",
    env: { ...process.env, [UPDATED_ENV]: "1" },
  });
  process.exit(res.status ?? 1);
}

async function updateCommand() {
  if (!updatesEnabled({ ...process.env, SESH_NO_UPDATE: "" }, SELF, {})) {
    throw new Error(`This sesh runs from ${SELF}, not the installed ~/.sesh/sesh.mjs, so it can't update itself.`);
  }
  const latest = await latestCli({ force: true });
  if (!latest)
    throw new Error("Could not find the latest sesh release (offline or rate limited by GitHub). Try again later.");
  if (!newerThanThis(latest)) return void console.log(`sesh ${VERSION} is the newest version.`);
  await installUpdate(latest);
  console.log(`sesh ${latest.version} installed.`);
}

// --- Claude Code's settings --------------------------------------------------------------------------------------

function readSettings(file = settingsPath()) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`cannot read ${file}: ${err.message}`, { cause: err });
  }
}

/** The status line command in the settings, or "" for none. */
const statusLineCommand = (s) => (typeof s?.statusLine?.command === "string" ? s.statusLine.command : "");
/** Whether a status line command is sesh's (this CLI, or the earlier standalone script). */
export const isSeshCommand = (c) => /sesh(-statusline)?\.mjs/.test(c);

/** One yes/no question, on the terminal (with `curl | sh`, stdin is the script, so /dev/tty). No terminal means no. */
const ask = async (question) => {
  let input = process.stdin.isTTY ? process.stdin : null;
  if (!input) {
    try {
      input = createReadStream("/dev/tty");
      await new Promise((resolve, reject) => input.once("open", resolve).once("error", reject));
    } catch {
      return false;
    }
  }
  const rl = createInterface({ input, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
    if (input !== process.stdin) input.destroy();
  }
};

/** Makes sesh Claude Code's status line. Returns false when another status line was kept. */
async function statuslineOn({ replace = false } = {}) {
  const file = settingsPath();
  const settings = readSettings(file);
  const current = statusLineCommand(settings);
  const command = `"${process.execPath}" "${SELF}" statusline`;
  if (current && !isSeshCommand(current) && !replace && !process.env.SESH_REPLACE) {
    console.error(`Claude Code already has a status line: ${current}`);
    if (!(await ask("Replace it with sesh? [y/N] "))) {
      console.error(`Left it as it is. To use sesh's, set statusLine.command in ${file} to:\n  ${command}`);
      return false;
    }
  }
  // Only the user's own settings are worth keeping: a rerun must not replace that backup with one already changed.
  if (!isSeshCommand(current)) {
    try {
      writeFileSync(`${file}.bak`, readFileSync(file));
    } catch {
      // no settings yet
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // new file
  }
  // Rerun once a minute too, so the bar (and the report) keeps up between messages.
  writeJsonAtomic(file, { ...settings, statusLine: { type: "command", command, refreshInterval: 60 } }, mode);
  console.log(`Claude Code's status line is now sesh's (${file}). Restart Claude Code to see it.`);
  return true;
}

/** Removes sesh's status line from the settings; another status line is left alone. */
function statuslineOff() {
  const file = settingsPath();
  const settings = readSettings(file);
  const current = statusLineCommand(settings);
  if (!current || !isSeshCommand(current))
    return void console.log("Claude Code's status line isn't sesh's; nothing to remove.");
  const rest = { ...settings };
  delete rest.statusLine;
  writeFileSync(`${file}.bak`, readFileSync(file));
  writeJsonAtomic(file, rest, statSync(file).mode & 0o777);
  console.log(`Removed sesh's status line from ${file}.`);
}

// --- commands --------------------------------------------------------------------------------------------------

const mask = (t) => (t.length <= 8 ? "…" : `${t.slice(0, 4)}…${t.slice(-2)}`);

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

async function statusCommand() {
  const to = target();
  const raw = readRawConfig();
  const line = (k, v) => console.log(`${(k + ":").padEnd(14)}${v}`);
  line("sesh", `${VERSION}${updatesEnabled() ? "" : " (does not update itself)"}`);
  line("server", to ? new URL(to.url).origin : "not set (run `sesh setup`)");
  line("token", to ? mask(to.token) : "not set");
  let command = "";
  try {
    command = statusLineCommand(readSettings());
  } catch (err) {
    line("settings", err.message);
  }
  line("status line", !command ? "none" : isSeshCommand(command) ? "sesh" : `another one (${command})`);
  try {
    const last = JSON.parse(readFileSync(join(stateDir(), "statusline-last.json"), "utf8"));
    line("last reading", `${formatBar(last)}, posted ${ago(Date.now() - Date.parse(last.captured_at))}`);
  } catch {
    line("last reading", "none yet");
  }
  line("auto-update", raw.auto_update === false ? "off" : process.env.SESH_NO_UPDATE ? "off (SESH_NO_UPDATE)" : "on");
  if (!to) return;
  try {
    const res = await fetch(`${serverOrigin()}/health`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    line("reachable", res.ok ? "yes" : `no (HTTP ${res.status})`);
  } catch {
    line("reachable", "no");
  }
  const latest = await latestCli({ force: true });
  if (latest) line("newest", newerThanThis(latest) ? `${latest.version} (run \`sesh update\`)` : "this is it");
}

// Claude Code keeps each session's transcript as JSONL under <config dir>/projects/<project>/<session>.jsonl. Reading
// them stays in this file because the release ships sesh.mjs alone; the upload command reuses these functions.

const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Every .jsonl file under `dir`, at any depth; unreadable directories count as empty. */
function findTranscripts(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return findTranscripts(path);
    return e.isFile() && e.name.endsWith(".jsonl") ? [path] : [];
  });
}

/** Whether a transcript entry is a prompt the person typed: not a tool result, a meta message or a subagent's turn. */
function isPrompt(entry) {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.trim() !== "";
  return Array.isArray(content) && content.some((c) => c?.type === "text" && String(c.text ?? "").trim() !== "");
}

const count = (n) => (Number.isFinite(n) ? n : 0);

/**
 * What one transcript says about its session: `{ id, started_at, project, prompts, tokens }`, or null when it has no
 * entries. Bad lines are skipped. Tokens are input, output and cache tokens of each assistant message, counted once
 * (Claude Code writes a message once per content block). Prompt text is counted, never kept.
 */
export function parseTranscript(text, fallbackId = null) {
  let id = null;
  let started = null;
  let project = null;
  let prompts = 0;
  let entries = 0;
  const usage = new Map();
  for (const raw of text.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!entry || typeof entry.type !== "string") continue;
    entries++;
    if (!id && typeof entry.sessionId === "string") id = entry.sessionId;
    if (!project && typeof entry.cwd === "string") project = entry.cwd;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(at) && (started === null || at < started)) started = at;
    if (isPrompt(entry)) prompts++;
    const u = entry.type === "assistant" ? entry.message?.usage : null;
    if (u && typeof u === "object") {
      const total =
        count(u.input_tokens) +
        count(u.output_tokens) +
        count(u.cache_creation_input_tokens) +
        count(u.cache_read_input_tokens);
      usage.set(entry.message.id ?? `line-${usage.size}`, total);
    }
  }
  if (!entries) return null;
  const tokens = [...usage.values()].reduce((a, b) => a + b, 0);
  return {
    id: id ?? fallbackId,
    started_at: started === null ? null : new Date(started).toISOString(),
    project,
    prompts,
    tokens,
  };
}

/** The sessions in Claude Code's transcripts, newest first, each with the `files` it spans. Skips files that are empty, unreadable or not transcripts. */
export function scanSessions(env = process.env) {
  const root = join(claudeDir(env), "projects");
  const sessions = new Map();
  for (const file of findTranscripts(root)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const base = basename(file, ".jsonl");
    const found = parseTranscript(text, base);
    if (!found?.id) continue;
    // Subagent transcripts carry their parent's session id: they add to that session.
    const known = sessions.get(found.id);
    if (!known) {
      // The project directory's name stands in for a transcript with no cwd.
      sessions.set(found.id, { ...found, project: found.project ?? basename(dirname(file)), files: [file] });
      continue;
    }
    known.files.push(file);
    known.prompts += found.prompts;
    known.tokens += found.tokens;
    if (found.started_at && (!known.started_at || found.started_at < known.started_at))
      known.started_at = found.started_at;
  }
  return [...sessions.values()].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
}

function sessionsCommand() {
  const sessions = scanSessions();
  if (!sessions.length) return void console.log(`No Claude Code sessions found in ${join(claudeDir(), "projects")}.`);
  for (const s of sessions) {
    const date = s.started_at ? s.started_at.slice(0, 10) : "unknown";
    const prompts = `${s.prompts} ${s.prompts === 1 ? "prompt" : "prompts"}`;
    console.log([s.id, date, s.project, prompts, `${s.tokens} tokens`].join("  "));
  }
}

// --- upload: one past session as OTel ----------------------------------------------------------------------------

/** Under the server's 4 MB cap on one ingest request, with room for the envelope. */
const MAX_PAYLOAD_BYTES = 3_500_000;
const UPLOAD_TIMEOUT_MS = 60_000;
/** How many sessions a bulk upload sends at once. */
const UPLOAD_CONCURRENCY = 8;

/**
 * Every entry of one session across its transcripts (the main one and its subagents'), oldest first. `files` are the
 * transcripts to read, as `scanSessions` found them; without them every transcript on disk is searched.
 */
export function readSessionEntries(sessionId, env = process.env, files = null) {
  const entries = [];
  for (const file of files ?? findTranscripts(join(claudeDir(env), "projects"))) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const base = basename(file, ".jsonl");
    for (const raw of text.split("\n")) {
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!entry || typeof entry.type !== "string") continue;
      if ((typeof entry.sessionId === "string" ? entry.sessionId : base) !== sessionId) continue;
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isNaN(at)) entries.push({ entry, at, order: entries.length });
    }
  }
  return entries.sort((a, b) => a.at - b.at || a.order - b.order).map((e) => ({ ...e.entry, _at: e.at }));
}

const blocks = (entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []);

/** How many characters the person typed in a prompt entry. The text itself is never kept. */
function promptLength(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content.length;
  return blocks(entry).reduce((n, c) => (c?.type === "text" ? n + String(c.text ?? "").length : n), 0);
}

/**
 * The turns of a session as the events Claude Code would have logged live: per prompt, a `user_prompt` (its length
 * only), an `api_request` for each assistant message (model, tokens, duration) and a `tool_result` for each tool call
 * (name, success, duration). Returns `[{ promptId, records: [{ name, at, attrs }] }]`. Nothing the person typed,
 * no tool input or output and nothing about who they are is read into a record.
 */
export function buildTurns(entries, sessionId) {
  const turns = [];
  let turn = null;
  const byUuid = new Map();
  const tools = new Map();
  const messages = new Map();
  for (const entry of entries) {
    if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry._at);
    if (isPrompt(entry)) {
      const promptId =
        typeof entry.promptId === "string" && entry.promptId
          ? entry.promptId
          : typeof entry.uuid === "string" && entry.uuid
            ? entry.uuid
            : createHash("sha256").update(`${sessionId}\0${entry._at}`).digest("hex").slice(0, 32);
      turn = { promptId, records: [] };
      turns.push(turn);
      turn.records.push({
        name: "user_prompt",
        at: entry._at,
        attrs: { prompt_length: promptLength(entry) },
      });
      continue;
    }
    if (!turn) continue;
    if (entry.type === "assistant" && entry.message && typeof entry.message === "object") {
      const m = entry.message;
      if (m.model === "<synthetic>" || entry.isApiErrorMessage) continue;
      for (const c of blocks(entry))
        if (c?.type === "tool_use" && c.id && !tools.has(c.id)) tools.set(c.id, { name: c.name, at: entry._at });
      const u = m.usage && typeof m.usage === "object" ? m.usage : null;
      if (!u) continue;
      // Claude Code writes a message once per content block: one api_request, from the first block's parent to the last block.
      const key = m.id ?? `entry-${turn.records.length}`;
      let rec = messages.get(key);
      if (!rec) {
        const started = typeof entry.parentUuid === "string" ? byUuid.get(entry.parentUuid) : undefined;
        rec = { name: "api_request", at: entry._at, attrs: {}, started };
        messages.set(key, rec);
        turn.records.push(rec);
      }
      rec.at = entry._at;
      const attrs = { input_tokens: count(u.input_tokens), output_tokens: count(u.output_tokens) };
      attrs.cache_read_tokens = count(u.cache_read_input_tokens);
      attrs.cache_creation_tokens = count(u.cache_creation_input_tokens);
      if (typeof m.model === "string" && m.model) attrs.model = m.model;
      if (typeof entry.costUSD === "number" && Number.isFinite(entry.costUSD)) attrs.cost_usd = entry.costUSD;
      if (rec.started !== undefined && entry._at >= rec.started) attrs.duration_ms = entry._at - rec.started;
      rec.attrs = attrs;
      continue;
    }
    if (entry.type === "user") {
      for (const c of blocks(entry)) {
        if (c?.type !== "tool_result") continue;
        const tool = tools.get(c.tool_use_id);
        const attrs = { success: c.is_error !== true };
        if (tool?.name) attrs.tool_name = String(tool.name);
        if (tool) attrs.duration_ms = Math.max(0, entry._at - tool.at);
        turn.records.push({ name: "tool_result", at: entry._at, attrs });
      }
    }
  }
  return turns;
}

function otlpValue(v) {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

function otlpRecord(sessionId, promptId, r) {
  const attrs = {
    "event.name": r.name,
    "event.timestamp": new Date(r.at).toISOString(),
    "session.id": sessionId,
    "prompt.id": promptId,
    ...r.attrs,
  };
  return {
    timeUnixNano: String(BigInt(r.at) * 1_000_000n),
    body: { stringValue: `claude_code.${r.name}` },
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: otlpValue(v) })),
  };
}

const envelope = (logRecords) => ({
  resourceLogs: [
    {
      resource: { attributes: [{ key: "sesh.source", value: { stringValue: "backfill" } }] },
      scopeLogs: [{ scope: { name: "sesh.upload" }, logRecords }],
    },
  ],
});

/**
 * OTLP/JSON logs payloads for a session, each under `maxBytes`. Payloads break between turns, never inside one:
 * the server skips a turn it already has events for, so a turn cut in two would lose its second half. A single
 * turn bigger than `maxBytes` is cut anyway, and `dropped` counts the records that therefore can't be sent.
 */
export function buildPayloads(turns, sessionId, maxBytes = MAX_PAYLOAD_BYTES) {
  const overhead = JSON.stringify(envelope([])).length;
  const payloads = [];
  let batch = [];
  let size = overhead;
  let dropped = 0;
  let events = 0;
  const flush = () => {
    if (batch.length) payloads.push(envelope(batch));
    batch = [];
    size = overhead;
  };
  for (const t of turns) {
    const rows = t.records.map((r) => {
      const row = otlpRecord(sessionId, t.promptId, r);
      return { row, bytes: JSON.stringify(row).length + 1 };
    });
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    if (size + total > maxBytes) flush();
    if (total > maxBytes - overhead) {
      let used = overhead;
      for (const { row, bytes } of rows) {
        if (used + bytes > maxBytes) dropped++;
        else {
          batch.push(row);
          used += bytes;
        }
      }
      size = used;
      flush();
    } else {
      for (const { row } of rows) batch.push(row);
      size += total;
    }
    events += t.records.length;
  }
  flush();
  return { payloads, events: events - dropped, dropped };
}

/** Where upload posts: the configured server's /v1/logs. Null when there is no server set up. */
export function logsUrl(to) {
  return to ? to.url.replace(/\/v1\/limits$/, "") + "/v1/logs" : null;
}

/** Thrown for a problem every session would hit (a rejected token), so a bulk upload stops instead of failing each. */
class FatalUpload extends Error {}

/**
 * Sends one session's payloads. Returns `{ events, turns, requests, accepted, skipped }`: accepted and skipped are the
 * turns the server stored and the ones it already had, or null when the server didn't say (an older one).
 */
async function sendSession(sessionId, to, fetchFn, files = null) {
  const entries = readSessionEntries(sessionId, process.env, files);
  if (!entries.length)
    throw new Error(`No Claude Code session ${sessionId} found in ${join(claudeDir(), "projects")}.`);
  const turns = buildTurns(entries, sessionId);
  const { payloads, events, dropped } = buildPayloads(turns, sessionId);
  if (dropped)
    console.error(`sesh: a turn in ${sessionId} is too large to send whole; ${dropped} events are left out.`);
  const url = logsUrl(to);
  let accepted = 0;
  let skipped = 0;
  let known = true;
  for (const [i, payload] of payloads.entries()) {
    let res;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          authorization: `Bearer ${to.token}`,
        },
        body: gzipSync(JSON.stringify(payload)),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Could not reach ${new URL(url).origin}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (res.status === 401)
      throw new FatalUpload(
        "sesh rejected the token (401). Check it on sesh's Tokens tab, then run `sesh setup` again.",
      );
    if (!res.ok) throw new Error(`sesh answered ${res.status} for request ${i + 1} of ${payloads.length}.`);
    const body = await res.json().catch(() => null);
    const counts = body?.sesh;
    if (Number.isFinite(counts?.turns_accepted) && Number.isFinite(counts?.turns_skipped)) {
      accepted += counts.turns_accepted;
      skipped += counts.turns_skipped;
    } else known = false;
  }
  return {
    events,
    turns: turns.length,
    requests: payloads.length,
    accepted: known ? accepted : null,
    skipped: known ? skipped : null,
  };
}

/** The value after `--name` in `args`, `true` for a bare flag, or undefined when absent. */
function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

/**
 * Which sessions an upload covers. `all` takes everything; `since` (a date) keeps sessions that started on or after it
 * (a session with no start time never matches); `project` keeps sessions whose project path contains the text.
 * Filters combine with and.
 */
export function selectSessions(sessions, { all = false, since = null, project = null } = {}) {
  let from = null;
  if (since !== null) {
    from = Date.parse(since);
    if (Number.isNaN(from)) throw new Error(`--since needs a date like 2026-10-01, not "${since}".`);
  }
  if (project !== null && project === "") throw new Error("--project needs some text of the project path.");
  return sessions.filter((s) => {
    if (from !== null && !(s.started_at && Date.parse(s.started_at) >= from)) return false;
    if (project !== null && !(s.project ?? "").includes(project)) return false;
    return all || from !== null || project !== null;
  });
}

/** The indexes (0-based) a person's answer picks from a list of `max`: "all", "1,3", "2-4". Null for an answer that isn't one. */
export function parseChoice(answer, max) {
  const text = answer.trim().toLowerCase();
  if (text === "all" || text === "a") return Array.from({ length: max }, (_, i) => i);
  const picked = new Set();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (lo < 1 || hi < lo || hi > max) return null;
    for (let n = lo; n <= hi; n++) picked.add(n - 1);
  }
  return [...picked].sort((a, b) => a - b);
}

/** Lists the sessions and asks which to upload, on the terminal. Returns the chosen ones (none on an empty answer). */
async function chooseSessions(sessions) {
  sessions.forEach((s, i) => {
    const date = s.started_at ? s.started_at.slice(0, 10) : "unknown";
    console.error(`${String(i + 1).padStart(3)}  ${date}  ${s.project}  ${s.prompts} prompts  ${s.id}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = await rl.question('Upload which? (numbers like 1,3-5, "all", or Enter for none) ');
      if (!answer.trim()) return [];
      const picked = parseChoice(answer, sessions.length);
      if (picked) return picked.map((i) => sessions[i]);
      console.error(`Pick numbers between 1 and ${sessions.length}.`);
    }
  } finally {
    rl.close();
  }
}

/** What a session's transcripts look like now: if it is unchanged since the last upload, there is nothing to send. */
function sessionSignature(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    try {
      const st = statSync(file);
      hash.update(`${file}:${st.size}:${st.mtimeMs}\n`);
    } catch {
      hash.update(`${file}:gone\n`);
    }
  }
  return hash.digest("hex");
}

/** The sessions already uploaded to this server: `{ [sessionId]: signature }`, kept in ~/.sesh/uploaded.json. */
function readLedger(origin, env = process.env) {
  try {
    const all = JSON.parse(readFileSync(join(stateDir(env), "uploaded.json"), "utf8"));
    return all?.[origin] && typeof all[origin] === "object" ? all[origin] : {};
  } catch {
    return {};
  }
}

function writeLedger(origin, ledger, env = process.env) {
  const file = join(stateDir(env), "uploaded.json");
  let all = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    // no ledger yet
  }
  mkdirSync(stateDir(env), { recursive: true });
  writeJsonAtomic(file, { ...all, [origin]: ledger }, 0o600);
}

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** A progress line for a bulk upload: how many are done, how long it has run and how long is left. */
export function progressLine(done, total, elapsedMs) {
  const left = done > 0 && done < total ? `, about ${clock((elapsedMs / done) * (total - done))} left` : "";
  return `${done}/${total} sessions (${clock(elapsedMs)} so far${left})`;
}

const UPLOAD_USAGE =
  "Usage: sesh upload <session-id> | --all | --since <date> | --project <text>  [--dry-run] [--force]\n" +
  "`sesh sessions` lists the ids; `sesh upload` alone lets you pick on a terminal.";

/** The summary line of a bulk upload. */
export function uploadSummary({ sent, accepted, skipped, failed, events, unchanged = 0 }) {
  return (
    `Sent ${sent} ${sent === 1 ? "session" : "sessions"} (${events} events): ${accepted} turns accepted, ` +
    `${skipped} already known, ${failed} ${failed === 1 ? "session" : "sessions"} failed.` +
    (unchanged
      ? ` ${unchanged} already uploaded ${unchanged === 1 ? "was" : "were"} left out (--force sends them again).`
      : "")
  );
}

async function uploadCommand(args, { fetchFn = fetch } = {}) {
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const since = flagValue(args, "--since");
  const project = flagValue(args, "--project");
  const valued = new Set([since, project].filter((v) => typeof v === "string"));
  const ids = args.filter((a) => !a.startsWith("--") && !valued.has(a));
  const filtered = all || since !== undefined || project !== undefined;
  if (since === true || project === true) throw new Error(UPLOAD_USAGE);
  if (ids.length > 1 || (ids.length && filtered)) throw new Error(UPLOAD_USAGE);
  if (!ids.length && !filtered && !process.stdin.isTTY) throw new Error(UPLOAD_USAGE);

  const to = target();
  if (!dryRun && !to)
    throw new Error("No sesh to send to. Run `sesh setup` (or set SESH_URL and SESH_TOKEN) and try again.");

  let chosen;
  if (ids.length) chosen = [{ id: ids[0] }];
  else {
    const found = scanSessions();
    if (!found.length) throw new Error(`No Claude Code sessions found in ${join(claudeDir(), "projects")}.`);
    chosen = filtered
      ? selectSessions(found, { all, since: since ?? null, project: project ?? null })
      : await chooseSessions(found);
    if (!chosen.length) return void console.log("No sessions selected. Nothing was sent.");
  }

  if (dryRun) {
    let events = 0;
    for (const s of chosen) {
      const entries = readSessionEntries(s.id, process.env, s.files ?? null);
      if (!entries.length) throw new Error(`No Claude Code session ${s.id} found in ${join(claudeDir(), "projects")}.`);
      const turns = buildTurns(entries, s.id);
      const built = buildPayloads(turns, s.id);
      if (built.dropped)
        console.error(`sesh: a turn in ${s.id} is too large to send whole; ${built.dropped} events are left out.`);
      if (chosen.length === 1) for (const p of built.payloads) console.log(JSON.stringify(p, null, 2));
      else console.error(`${s.id}: ${built.events} events in ${turns.length} turns, ${built.payloads.length} requests`);
      events += built.events;
    }
    console.error(
      `Dry run: ${events} events from ${chosen.length} ${chosen.length === 1 ? "session" : "sessions"}. Nothing was sent.`,
    );
    return;
  }

  if (chosen.length === 1 && ids.length) {
    // One named session: a failure is the command's failure.
    const r = await sendSession(chosen[0].id, to, fetchFn, chosen[0].files ?? null);
    const server =
      r.accepted === null
        ? "Turns sesh already has are skipped by the server."
        : `${r.accepted} turns accepted, ${r.skipped} already known.`;
    console.log(
      `Sent ${r.events} events from ${r.turns} turns of ${chosen[0].id} in ${r.requests} ` +
        `${r.requests === 1 ? "request" : "requests"}. ${server}`,
    );
    return;
  }

  // A session whose transcripts haven't changed since it was last uploaded is left out, unless --force.
  const origin = new URL(to.url).origin;
  const ledger = readLedger(origin);
  const signatures = new Map(chosen.map((s) => [s.id, sessionSignature(s.files ?? [])]));
  const force = args.includes("--force");
  const todo = force ? chosen : chosen.filter((s) => ledger[s.id] !== signatures.get(s.id));
  const total = { sent: 0, accepted: 0, skipped: 0, failed: 0, events: 0, unchanged: chosen.length - todo.length };
  if (total.unchanged)
    console.error(`${total.unchanged} of ${chosen.length} sessions are already uploaded and unchanged; skipping them.`);

  const started = Date.now();
  const live = process.stderr.isTTY;
  let done = 0;
  let stopped = false;
  const progress = () => {
    if (live) process.stderr.write(`\r\x1b[K${progressLine(done, todo.length, Date.now() - started)}`);
    else if (done === todo.length || done % 25 === 0)
      console.error(progressLine(done, todo.length, Date.now() - started));
  };
  // Failures print on their own line, above the progress line.
  const say = (text) => {
    if (live) process.stderr.write("\r\x1b[K");
    console.error(text);
  };
  let next = 0;
  const worker = async () => {
    while (!stopped && next < todo.length) {
      const s = todo[next++];
      try {
        const r = await sendSession(s.id, to, fetchFn, s.files ?? null);
        total.sent++;
        total.events += r.events;
        total.accepted += r.accepted ?? 0;
        total.skipped += r.skipped ?? 0;
        ledger[s.id] = signatures.get(s.id);
      } catch (err) {
        total.failed++;
        say(`${s.id}: failed: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof FatalUpload) {
          stopped = true;
          say(`Stopping: the sessions left would fail the same way.`);
        }
      }
      done++;
      progress();
      if (done % 25 === 0) writeLedger(origin, ledger);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, todo.length) }, worker));
  } finally {
    writeLedger(origin, ledger);
    if (live && done) process.stderr.write("\n");
  }
  console.log(uploadSummary(total));
  Object.assign(outcomeProps, { sessions_sent: total.sent, sessions_failed: total.failed });
  if (total.failed) process.exitCode = 1;
}

/** Flags of the form `--name value` and `--name`, and the plain words. */
function parseArgs(args) {
  const flags = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) words.push(args[i]);
    else if (args[i + 1] && !args[i + 1].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else flags[args[i].slice(2)] = true;
  }
  return { flags, words };
}

async function setupCommand(args) {
  const { flags } = parseArgs(args);
  const settingsEnv = readSettings().env ?? {};
  let to;
  if (typeof flags.url === "string" && typeof flags.token === "string") {
    to = { url: new URL("/v1/limits", flags.url).href, token: flags.token };
  } else {
    // The OTel export from sesh's tokens page: in this shell or Claude Code's settings.
    to = target({ ...process.env, ...settingsEnv, SESH_URL: "", SESH_TOKEN: "" }, null) ?? readConfig();
  }
  if (!to) {
    throw new Error(
      "No sesh to report to. Set up the OTel export from sesh's tokens page (OTEL_EXPORTER_OTLP_ENDPOINT and an\n" +
        "Authorization=Bearer header in OTEL_EXPORTER_OTLP_HEADERS) and run this again, or pass --url <server> --token <token>.",
    );
  }
  writeConfig({ ...readRawConfig(), url: to.url, token: to.token });
  console.log(`Reporting plan usage to ${new URL(to.url).origin}.`);
  await statuslineOn({ replace: !!flags.replace });
}

function configCommand(args) {
  const [verb, key, value] = args;
  const raw = readRawConfig();
  if (!verb) {
    const to = readConfig();
    console.log(
      JSON.stringify(
        { url: to?.url ?? null, token: to ? mask(to.token) : null, auto_update: raw.auto_update !== false },
        null,
        2,
      ),
    );
    return;
  }
  if (verb !== "set" || !key || value === undefined)
    throw new Error("Usage: sesh config [set <url|token|auto_update> <value>]");
  if (key === "url") raw.url = new URL("/v1/limits", value).href;
  else if (key === "token") raw.token = value;
  else if (key === "auto_update") {
    if (!["on", "off"].includes(value)) throw new Error("auto_update is on or off.");
    raw.auto_update = value === "on";
  } else throw new Error(`Unknown setting ${key}: use url, token or auto_update.`);
  writeConfig(raw);
  console.log(`Set ${key}.`);
}

const HELP = `sesh ${VERSION}: session insights for Claude Code teams

  sesh status              what is set up: server, token, status line, last reading, updates
  sesh sessions            list the Claude Code sessions on this machine (local files only, no network)
  sesh upload <session-id> send one past session to sesh as OTel logs (--dry-run prints them, sends nothing)
  sesh upload              pick sessions from a list (on a terminal), or choose them with --all, --since <date>,
                           --project <text>; safe to run again: sessions already uploaded and unchanged are skipped
                           (--force sends them again) and the server skips turns it already has
  sesh setup [--replace]   save the server and token (from the OTel settings, or --url and --token) and make sesh
                           Claude Code's status line
  sesh statusline on|off   make sesh Claude Code's status line, or remove it
  sesh config              show the settings
  sesh config set <url|token|auto_update> <value>
  sesh update              install the newest version now (sesh also does it by itself; auto_update off stops that)
  sesh --version
`;

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") return void console.log(VERSION);
  if (command === "--help" || command === "-h" || command === "help" || !command) return void console.log(HELP);
  if (command === "statusline" && !rest[0]) return runStatusline();
  if (command === "statusline" && rest[0] === "--background") return runBackground();
  // Changing the settings is how updates get turned off, so it never waits on one;
  // sessions reads local files only, so it never touches the network.
  // A dry-run upload makes no request at all.
  const quiet = command === "config" || command === "sessions" || (command === "upload" && rest.includes("--dry-run"));
  if (!quiet) await updateBeforeCommand(argv);
  const commands = {
    status: () => statusCommand(),
    sessions: () => sessionsCommand(),
    upload: () => uploadCommand(rest),
    setup: () => setupCommand(rest),
    update: () => updateCommand(),
    config: () => configCommand(rest),
    statusline: () => {
      if (rest[0] === "on") return statuslineOn({ replace: rest.includes("--replace") });
      if (rest[0] === "off") return statuslineOff();
      throw new Error(`Unknown command: ${argv.join(" ")}\n\n${HELP}`);
    },
  };
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${argv.join(" ")}\n\n${HELP}`);
  return counted(command, quiet, async () => void (await commands[command]()));
}

if (process.argv[1] && sameFile(SELF, process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    // The status line must never show an error; every other command says what went wrong.
    if (process.argv[2] !== "statusline") {
      console.error(`sesh: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });
}
