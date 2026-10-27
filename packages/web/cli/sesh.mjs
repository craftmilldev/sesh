#!/usr/bin/env node
// sesh: the command line for sesh (session insights for Claude Code teams), and the Claude Code status line that
// reports plan usage to it. Plain Node 22+, no dependencies, one file: the sesh server serves it at /cli/sesh.mjs
// and install.sh puts it at ~/.sesh/sesh.mjs. An installed copy keeps itself current from the server it reports to.
//
//   sesh status              what is set up: server, token, status line, last reading, updates
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
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
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
      if (latest && latest.sha256 !== ownHash()) await installUpdate(latest);
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

const ownHash = () => createHash("sha256").update(readFileSync(SELF)).digest("hex");

/** The server the CLI reports to and updates from: the one in config.json or SESH_URL, else sesh's own. */
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
 * The newest CLI the server has, `{ version, sha256 }`, from the server or (within ten minutes of the last lookup)
 * from ~/.sesh/update-check.json. Null when it can't be found; a failed lookup is remembered as long as a good one.
 */
async function latestCli({ force = false, fetchFn = fetch, now = Date.now() }) {
  const cached = readCheck();
  if (!force && cached && now - cached.checked_at < CHECK_TTL_MS) return cached.latest ?? null;
  let latest = null;
  try {
    const res = await fetchFn(`${serverOrigin()}/cli/version`, {
      headers: { "x-sesh-cli-version": VERSION },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = await res.json();
      if (typeof body.version === "string" && /^[0-9a-f]{64}$/.test(body.sha256)) {
        latest = { version: body.version, sha256: body.sha256 };
      }
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

/** Downloads the server's CLI and puts it over this one if it is the file `latest` describes and runs. Returns whether it did. */
async function installUpdate(latest, fetchFn = fetch) {
  const res = await fetchFn(`${serverOrigin()}/cli/sesh.mjs`, {
    headers: { "x-sesh-cli-version": VERSION },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`could not download the new version (${res.status})`);
  const body = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(body).digest("hex") !== latest.sha256) {
    throw new Error("the download isn't the version the server announced");
  }
  const tmp = join(dirname(SELF), `.sesh.${process.pid}.mjs`);
  try {
    writeFileSync(tmp, body, { mode: 0o755 });
    // A bad file must not replace a working one.
    const run = spawnSync(process.execPath, [tmp, "--version"], { encoding: "utf8", timeout: 10_000 });
    if (run.status !== 0 || !/^\d+\.\d+\.\d+/.test(run.stdout)) throw new Error("the new version doesn't run");
    chmodSync(tmp, 0o755);
    renameSync(tmp, SELF);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

/** Before a command: installs a newer version if there is one, and runs the command again on it. Never blocks a command. */
async function updateBeforeCommand(argv) {
  if (process.env[UPDATED_ENV] || !updatesEnabled()) return;
  try {
    const latest = await latestCli({});
    if (!latest || latest.sha256 === ownHash()) return;
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
  if (!latest) throw new Error(`Could not reach ${serverOrigin()} to look for a new version.`);
  if (latest.sha256 === ownHash()) return void console.log(`sesh ${VERSION} is the newest version.`);
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
  try {
    writeFileSync(`${file}.bak`, readFileSync(file));
  } catch {
    // no settings yet
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
  if (latest) line("newest", latest.sha256 === ownHash() ? "this is it" : `${latest.version} (run \`sesh update\`)`);
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
  // Changing the settings is how updates get turned off, so it never waits on one.
  if (command !== "config") await updateBeforeCommand(argv);
  if (command === "status") return statusCommand();
  if (command === "setup") return setupCommand(rest);
  if (command === "update") return updateCommand();
  if (command === "config") return configCommand(rest);
  if (command === "statusline" && rest[0] === "on")
    return void (await statuslineOn({ replace: rest.includes("--replace") }));
  if (command === "statusline" && rest[0] === "off") return statuslineOff();
  throw new Error(`Unknown command: ${argv.join(" ")}\n\n${HELP}`);
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
