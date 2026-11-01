import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildPayloads,
  capture,
  IDENTITY,
  metricsOff,
  buildTurns,
  formatBar,
  isNewer,
  isSeshCommand,
  parseChoice,
  parseInput,
  parseTranscript,
  progressLine,
  logsUrl,
  readConfig,
  readSessionEntries,
  releaseVersion,
  reportable,
  scanSessions,
  selectSessions,
  serverOrigin,
  target,
  updatesEnabled,
  uploadSummary,
  VERSION,
} from "../sesh.mjs";

const run = promisify(execFile);
const SOURCE = new URL("../sesh.mjs", import.meta.url).pathname;

/** An installed sesh in a temp home: ~/.sesh/sesh.mjs and a Claude config dir, as `sesh` sees them. */
function home(extraEnv: Record<string, string> = {}) {
  const script = SOURCE;
  const root = mkdtempSync(join(tmpdir(), "sesh-cli-"));
  const state = join(root, ".sesh");
  mkdirSync(state);
  copyFileSync(script, join(state, "sesh.mjs"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    SESH_STATE_DIR: state,
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    SESH_TELEMETRY: "0",
    ...extraEnv,
  };
  const sesh = (...args: string[]) =>
    run(process.execPath, [join(state, "sesh.mjs"), ...args], { env }).then(
      (r) => ({ ...r, code: 0 }),
      (e: { stdout: string; stderr: string; code: number }) => e,
    );
  return { root, state, env, sesh, settings: join(root, ".claude", "settings.json") };
}

describe("the sesh CLI", () => {
  it("prints its version and help", async () => {
    const h = home();
    expect((await h.sesh("--version")).stdout.trim()).toBe(VERSION);
    expect((await h.sesh("help")).stdout).toContain("sesh setup");
    const bad = await h.sesh("nope");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Unknown command");
  });

  it("setup saves the target and makes sesh the status line, keeping other settings", async () => {
    const h = home();
    mkdirSync(join(h.root, ".claude"));
    writeFileSync(h.settings, JSON.stringify({ theme: "dark" }));
    const out = await h.sesh("setup", "--url", "https://sesh.test", "--token", "tok_abcdefgh");
    expect(out.stdout).toContain("Reporting plan usage to https://sesh.test");
    expect(JSON.parse(readFileSync(join(h.state, "config.json"), "utf8"))).toEqual({
      url: "https://sesh.test/v1/limits",
      token: "tok_abcdefgh",
    });
    const settings = JSON.parse(readFileSync(h.settings, "utf8")) as {
      theme: string;
      statusLine: { command: string; refreshInterval: number };
    };
    expect(settings.theme).toBe("dark");
    expect(settings.statusLine.command).toContain("sesh.mjs");
    expect(settings.statusLine.command).toContain("statusline");
    expect(settings.statusLine.refreshInterval).toBe(60);
    expect(readFileSync(`${h.settings}.bak`, "utf8")).toContain("dark");
  });

  it("setup takes the target from the OTel settings in Claude Code's settings.json", async () => {
    const h = home();
    mkdirSync(join(h.root, ".claude"));
    writeFileSync(
      h.settings,
      JSON.stringify({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://sesh.test",
          OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer tok_otel12345",
        },
      }),
    );
    await h.sesh("setup");
    expect(JSON.parse(readFileSync(join(h.state, "config.json"), "utf8"))).toMatchObject({
      url: "https://sesh.test/v1/limits",
      token: "tok_otel12345",
    });
  });

  it("setup says what is missing when there is no OTel export or token", async () => {
    const out = await home().sesh("setup");
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("No sesh to report to");
  });

  it("leaves another status line alone unless told to replace it, and statusline off only removes sesh's", async () => {
    const h = home();
    mkdirSync(join(h.root, ".claude"));
    const other = { statusLine: { type: "command", command: "echo hi" } };
    writeFileSync(h.settings, JSON.stringify(other));
    const kept = await h.sesh("setup", "--url", "https://sesh.test", "--token", "tok_abcdefgh");
    expect(kept.stderr).toContain("already has a status line");
    expect(JSON.parse(readFileSync(h.settings, "utf8"))).toEqual(other);
    await h.sesh("statusline", "off");
    expect(JSON.parse(readFileSync(h.settings, "utf8"))).toEqual(other);

    await h.sesh("statusline", "on", "--replace");
    expect(isSeshCommand((JSON.parse(readFileSync(h.settings, "utf8")) as typeof other).statusLine.command)).toBe(true);
    await h.sesh("statusline", "off");
    expect(JSON.parse(readFileSync(h.settings, "utf8"))).toEqual({});
  });

  it("config shows the settings with the token masked, and sets auto_update", async () => {
    const h = home();
    await h.sesh("config", "set", "url", "https://sesh.test");
    await h.sesh("config", "set", "token", "tok_abcdefgh");
    await h.sesh("config", "set", "auto_update", "off");
    const shown = JSON.parse((await h.sesh("config")).stdout) as Record<string, unknown>;
    expect(shown).toEqual({ url: "https://sesh.test/v1/limits", token: "tok_…gh", auto_update: false });
    expect((await h.sesh("config", "set", "auto_update", "maybe")).code).toBe(1);
  });

  it("the status line prints the bar, whatever it is given", async () => {
    const h = home();
    const input = readFileSync(new URL("./fixtures/statusline-input.json", import.meta.url), "utf8");
    const bar = async (stdin: string) => {
      const child = execFile(process.execPath, [join(h.state, "sesh.mjs"), "statusline"], { env: h.env });
      const out = new Promise<string>((resolve) => {
        let s = "";
        child.stdout?.on("data", (d: string) => (s += d));
        child.on("close", () => resolve(s));
      });
      child.stdin?.end(stdin);
      return (await out).trim();
    };
    expect(await bar(input)).toBe("5h 19% | 7d 8%");
    expect(await bar("not json")).toBe("5h n/a | 7d n/a");
  });
});

describe("updating", () => {
  let server: Server;
  let origin: string;
  let served: Buffer;
  let latestTag: string;
  let hits: string[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/repos/craftmilldev/sesh/releases/latest") res.end(JSON.stringify({ tag_name: latestTag }));
      else if (req.url === "/craftmilldev/sesh/releases/download/cli-v9.9.9/sesh.mjs") res.end(served);
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => void server.close());
  beforeEach(() => {
    hits = [];
    latestTag = "cli-v9.9.9";
    served = Buffer.from(readFileSync(SOURCE, "utf8").replace(`VERSION = "${VERSION}"`, 'VERSION = "9.9.9"'));
  });
  const installed = (extra: Record<string, string> = {}) =>
    home({ SESH_API_URL: origin, SESH_DOWNLOAD_URL: origin, ...extra });

  it("an installed copy installs the newest release before a command and runs the command on it", async () => {
    const h = installed();
    // --version is answered without updating; any other command updates first
    expect((await h.sesh("--version")).stdout.trim()).toBe(VERSION);
    const status = await h.sesh("status");
    expect(status.stderr).toContain(`Updating sesh ${VERSION} → 9.9.9`);
    expect(status.stdout).toContain("sesh:         9.9.9");
    expect(readFileSync(join(h.state, "sesh.mjs"), "utf8")).toContain('VERSION = "9.9.9"');
    // the lookup is remembered, so the next command doesn't ask again
    hits.length = 0;
    await h.sesh("status");
    expect(hits).not.toContain("/repos/craftmilldev/sesh/releases/latest");
  });

  it("does nothing when the newest release isn't newer, or isn't a CLI release", async () => {
    for (const tag of [`cli-v${VERSION}`, "v99.0.0"]) {
      latestTag = tag;
      const h = installed();
      const status = await h.sesh("status");
      expect(status.stderr).not.toContain("Updating");
      expect(status.stdout).toContain(`sesh:         ${VERSION}`);
    }
  });

  it("does not update with auto_update off, or when it isn't the installed copy", async () => {
    const h = installed();
    writeFileSync(join(h.state, "config.json"), JSON.stringify({ auto_update: false }));
    const status = await h.sesh("status");
    expect(status.stderr).not.toContain("Updating");
    expect(status.stdout).toContain(`sesh:         ${VERSION}`);
    const checkout = await run(process.execPath, [SOURCE, "update"], { env: h.env }).catch(
      (e: { stderr: string }) => e,
    );
    expect(checkout).toMatchObject({ stderr: expect.stringContaining("can't update itself") as string });
  });

  it("keeps the working copy when the download isn't the release it names", async () => {
    served = Buffer.from("console.log('evil')");
    const h = installed();
    const status = await h.sesh("status");
    expect(status.stderr).toContain("isn't sesh 9.9.9");
    expect(status.stdout).toContain(`sesh:         ${VERSION}`);
    expect(readFileSync(join(h.state, "sesh.mjs"), "utf8")).not.toContain("evil");
  });

  it("sesh update installs now, whatever the cached lookup says", async () => {
    latestTag = `cli-v${VERSION}`;
    const h = installed({ SESH_NO_UPDATE: "1" });
    expect((await h.sesh("update")).stdout).toContain("is the newest version");
    latestTag = "cli-v9.9.9";
    expect((await h.sesh("update")).stdout).toContain("sesh 9.9.9 installed");
  });

  it("compares versions and release tags, and finds the server from config or SESH_URL", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.0.9", "0.1.0")).toBe(false);
    expect(releaseVersion("cli-v1.2.3")).toBe("1.2.3");
    expect(releaseVersion("v1.2.3")).toBeUndefined();
    expect(serverOrigin({}, { url: "https://a.test/v1/limits", token: "t" })).toBe("https://a.test");
    expect(serverOrigin({ SESH_URL: "https://b.test/x" }, null)).toBe("https://b.test");
    expect(serverOrigin({}, null)).toBe("https://sesh.craftmill.dev");
    expect(updatesEnabled({ SESH_STATE_DIR: "/x" }, "/x/sesh.mjs", {})).toBe(true);
    expect(updatesEnabled({ SESH_STATE_DIR: "/x" }, "/repo/cli/sesh.mjs", {})).toBe(false);
    expect(updatesEnabled({ SESH_STATE_DIR: "/x", SESH_NO_UPDATE: "1" }, "/x/sesh.mjs", {})).toBe(false);
    expect(updatesEnabled({ SESH_STATE_DIR: "/x" }, "/x/sesh.mjs", { auto_update: false })).toBe(false);
  });
});

const input = readFileSync(new URL("./fixtures/statusline-input.json", import.meta.url), "utf8");

describe("status line script", () => {
  it("keeps only the session id and limits from the captured input", () => {
    const s = parseInput(input, new Date("2026-10-22T00:00:00Z"));
    expect(s).toEqual({
      session_id: "0f6c2f0e-3b2a-4a55-9d0e-6a7c0a1b2c3d",
      five_hour_pct: 19,
      five_hour_resets_at: 1792000000,
      seven_day_pct: 8,
      seven_day_resets_at: 1792400000,
      captured_at: "2026-10-22T00:00:00.000Z",
    });
    expect(formatBar(s)).toBe("5h 19% | 7d 8%");
    expect(reportable(s)).toBe(true);
  });

  it("handles input without limits or that is not JSON", () => {
    const none = parseInput('{"session_id":"x"}');
    expect(formatBar(none)).toBe("5h n/a | 7d n/a");
    expect(reportable(none)).toBe(false);
    expect(parseInput("not json")).toBeNull();
    expect(formatBar(null)).toBe("5h n/a | 7d n/a");
    expect(reportable(null)).toBe(false);
  });

  it("posts where config.json says, unless SESH_URL and SESH_TOKEN say otherwise, then where the OTel export goes", () => {
    const config = { url: "https://saved.test/v1/limits", token: "tok_saved" };
    const otel = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://sesh.test/",
      OTEL_EXPORTER_OTLP_HEADERS: "x-other=1,Authorization=Bearer tok_otel",
    };
    expect(target(otel, config)).toEqual(config);
    expect(target(otel, null)).toEqual({ url: "https://sesh.test/v1/limits", token: "tok_otel" });
    expect(
      target(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.test/otel",
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20t",
        },
        null,
      ),
    ).toEqual({ url: "https://c.test/otel/v1/limits", token: "t" });
    expect(target({ ...otel, SESH_URL: "https://other.test", SESH_TOKEN: "tok_sesh" }, config)).toEqual({
      url: "https://other.test/v1/limits",
      token: "tok_sesh",
    });
    expect(target({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://sesh.test" }, null)).toBeNull();
    expect(target({}, null)).toBeNull();
  });

  it("reads config.json, and treats a missing or broken one as none", () => {
    const dir = mkdtempSync(join(tmpdir(), "sesh-config-"));
    const file = join(dir, "config.json");
    expect(readConfig(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ url: "https://saved.test/v1/limits", token: "tok_saved" }));
    expect(readConfig(file)).toEqual({ url: "https://saved.test/v1/limits", token: "tok_saved" });
    writeFileSync(file, JSON.stringify({ url: "not a url", token: "tok_saved" }));
    expect(readConfig(file)).toBeNull();
    writeFileSync(file, "{");
    expect(readConfig(file)).toBeNull();
  });
});

describe("sessions", () => {
  const line = (o: object) => JSON.stringify(o);
  const usage = (n: number) => ({
    input_tokens: n,
    output_tokens: n,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
  });
  const SECRET = "my secret prompt text";

  const first = [
    line({
      type: "user",
      sessionId: "s-one",
      cwd: "/work/app",
      timestamp: "2026-10-01T10:00:00Z",
      message: { content: SECRET },
    }),
    line({
      type: "assistant",
      sessionId: "s-one",
      timestamp: "2026-10-01T10:00:05Z",
      message: { id: "m1", usage: usage(10) },
    }),
    // The same message again, once per content block: counted once.
    line({
      type: "assistant",
      sessionId: "s-one",
      timestamp: "2026-10-01T10:00:06Z",
      message: { id: "m1", usage: usage(10) },
    }),
    line({
      type: "user",
      sessionId: "s-one",
      timestamp: "2026-10-01T10:01:00Z",
      message: { content: [{ type: "tool_result", content: "x" }] },
    }),
    line({ type: "user", sessionId: "s-one", isMeta: true, message: { content: "meta" } }),
    "{not json",
    line({
      type: "user",
      sessionId: "s-one",
      timestamp: "2026-10-01T10:02:00Z",
      message: { content: [{ type: "text", text: SECRET }] },
    }),
  ].join("\n");
  const second = [
    line({
      type: "user",
      sessionId: "s-two",
      cwd: "/work/other",
      timestamp: "2026-10-03T09:00:00Z",
      message: { content: "hi" },
    }),
    line({ type: "assistant", sessionId: "s-two", message: { id: "m9", usage: usage(1) } }),
  ].join("\n");

  function claude() {
    const h = home();
    const projects = join(h.root, ".claude", "projects");
    mkdirSync(join(projects, "-work-app"), { recursive: true });
    mkdirSync(join(projects, "-work-other"), { recursive: true });
    writeFileSync(join(projects, "-work-app", "s-one.jsonl"), first);
    writeFileSync(join(projects, "-work-other", "s-two.jsonl"), second);
    writeFileSync(join(projects, "-work-app", "empty.jsonl"), "");
    writeFileSync(join(projects, "-work-app", "junk.jsonl"), "garbage\n\u0000\u0001\n[]\n");
    return { h, projects };
  }

  it("parses a transcript: prompts, de-duplicated tokens, start", () => {
    expect(parseTranscript(first)).toEqual({
      id: "s-one",
      started_at: "2026-10-01T10:00:00.000Z",
      project: "/work/app",
      prompts: 2,
      tokens: 10 + 10 + 1 + 2,
    });
    expect(parseTranscript("")).toBeNull();
    expect(parseTranscript("nope\n")).toBeNull();
  });

  it("lists sessions newest first, without prompt text, skipping empty and broken files", async () => {
    const { h } = claude();
    const out = await h.sesh("sessions");
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split("\n")).toEqual([
      "s-two  2026-10-03  /work/other  1 prompt  5 tokens",
      "s-one  2026-10-01  /work/app  2 prompts  23 tokens",
    ]);
    expect(out.stdout).not.toContain(SECRET);
  });

  it("adds a subagent's transcript to its parent session", () => {
    const { h, projects } = claude();
    mkdirSync(join(projects, "-work-app", "s-one", "subagents"), { recursive: true });
    writeFileSync(
      join(projects, "-work-app", "s-one", "subagents", "agent-a.jsonl"),
      line({ type: "assistant", sessionId: "s-one", isSidechain: true, message: { id: "sub", usage: usage(100) } }),
    );
    const found = scanSessions(h.env).find((s) => s.id === "s-one");
    expect(found).toMatchObject({ prompts: 2, tokens: 23 + 203 });
  });

  it("says so when there are no sessions, and never touches the network", async () => {
    const h = home({ SESH_URL: "http://127.0.0.1:1", SESH_TOKEN: "t" });
    const out = await h.sesh("sessions");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("No Claude Code sessions found");
  });
});

interface LogsPayload {
  resourceLogs: {
    resource: { attributes: unknown[] };
    scopeLogs: { logRecords: { timeUnixNano: string; attributes: unknown[] }[] }[];
  }[];
}
const logsOf = (p: unknown) => p as LogsPayload;

describe("upload", () => {
  const line = (o: object) => JSON.stringify(o);
  const SECRET = "my secret prompt text";
  const TOOL_SECRET = "cat /etc/secret-file";
  const transcript = [
    line({
      type: "user",
      uuid: "u1",
      promptId: "p-1",
      sessionId: "s-up",
      cwd: "/work/app",
      gitBranch: "main",
      timestamp: "2026-10-01T10:00:00.000Z",
      message: { content: SECRET },
    }),
    line({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "s-up",
      timestamp: "2026-10-01T10:00:03.000Z",
      message: {
        id: "m1",
        model: "claude-opus-4-5",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 },
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: TOOL_SECRET } }],
      },
    }),
    // The same message again for its second content block.
    line({
      type: "assistant",
      uuid: "a2",
      parentUuid: "u1",
      sessionId: "s-up",
      timestamp: "2026-10-01T10:00:04.000Z",
      message: {
        id: "m1",
        model: "claude-opus-4-5",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 },
        content: [{ type: "text", text: "reply text" }],
      },
    }),
    line({
      type: "user",
      uuid: "u2",
      parentUuid: "a2",
      sessionId: "s-up",
      timestamp: "2026-10-01T10:00:06.500Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "file contents" }] },
    }),
    "{broken",
    line({
      type: "user",
      uuid: "u3",
      sessionId: "s-up",
      timestamp: "2026-10-01T10:05:00.000Z",
      message: { content: [{ type: "text", text: SECRET }] },
    }),
    line({
      type: "assistant",
      uuid: "a3",
      parentUuid: "u3",
      sessionId: "s-up",
      timestamp: "2026-10-01T10:05:02.000Z",
      message: { id: "m2", model: "<synthetic>", usage: { input_tokens: 1, output_tokens: 1 } },
    }),
    line({
      type: "assistant",
      uuid: "a4",
      parentUuid: "u3",
      sessionId: "s-up",
      timestamp: "2026-10-01T10:05:03.000Z",
      message: { id: "m3", model: "claude-haiku-4-5", usage: { input_tokens: 3, output_tokens: 4 } },
    }),
  ].join("\n");

  function setup(extraEnv: Record<string, string> = {}) {
    const h = home({ SESH_NO_UPDATE: "1", ...extraEnv });
    const dir = join(h.root, ".claude", "projects", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s-up.jsonl"), transcript);
    return h;
  }

  it("builds a turn per prompt with the tokens, tool calls and durations, and no text", () => {
    const h = setup();
    const turns = buildTurns(readSessionEntries("s-up", h.env), "s-up");
    expect(turns.map((t) => t.promptId)).toEqual(["p-1", "u3"]);
    expect(turns[0]!.records).toEqual([
      { name: "user_prompt", at: Date.parse("2026-10-01T10:00:00Z"), attrs: { prompt_length: SECRET.length } },
      {
        name: "api_request",
        at: Date.parse("2026-10-01T10:00:04Z"),
        started: Date.parse("2026-10-01T10:00:00Z"),
        attrs: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 7,
          cache_creation_tokens: 5,
          model: "claude-opus-4-5",
          duration_ms: 4000,
        },
      },
      {
        name: "tool_result",
        at: Date.parse("2026-10-01T10:00:06.500Z"),
        attrs: { success: false, tool_name: "Bash", duration_ms: 3500 },
      },
    ]);
    expect(turns[1]!.records.map((r) => r.name)).toEqual(["user_prompt", "api_request"]);
    const out = JSON.stringify(buildPayloads(turns, "s-up").payloads);
    for (const leak of [SECRET, TOOL_SECRET, "reply text", "file contents", "/work/app", "main"])
      expect(out).not.toContain(leak);
  });

  it("marks the payload as a backfill and keeps the original timestamps", () => {
    const h = setup();
    const { payloads, events } = buildPayloads(buildTurns(readSessionEntries("s-up", h.env), "s-up"), "s-up");
    expect(events).toBe(5);
    const rl = logsOf(payloads[0]).resourceLogs[0]!;
    expect(rl.resource.attributes).toEqual([{ key: "sesh.source", value: { stringValue: "backfill" } }]);
    const first = rl.scopeLogs[0]!.logRecords[0]!;
    expect(first.timeUnixNano).toBe(String(Date.parse("2026-10-01T10:00:00Z") * 1_000_000));
    expect(first.attributes).toContainEqual({
      key: "event.timestamp",
      value: { stringValue: "2026-10-01T10:00:00.000Z" },
    });
  });

  it("splits large sessions under the cap, between turns", () => {
    const entries = Array.from({ length: 40 }, (_, i) => [
      { type: "user", uuid: `u${i}`, sessionId: "big", _at: i * 1000, message: { content: "hi" } },
      {
        type: "assistant",
        uuid: `a${i}`,
        parentUuid: `u${i}`,
        sessionId: "big",
        _at: i * 1000 + 1,
        message: { id: `m${i}`, model: "x", usage: { input_tokens: 1 } },
      },
    ]).flat();
    const turns = buildTurns(entries, "big");
    const { payloads, events, dropped } = buildPayloads(turns, "big", 4000);
    expect(payloads.length).toBeGreaterThan(5);
    expect(events).toBe(80);
    expect(dropped).toBe(0);
    for (const p of payloads) {
      expect(JSON.stringify(p).length).toBeLessThanOrEqual(4000);
      // Both of a turn's records are in the same request.
      expect(logsOf(p).resourceLogs[0]!.scopeLogs[0]!.logRecords.length % 2).toBe(0);
    }
    expect(buildPayloads(turns, "big", 400).dropped).toBe(2 * 40);
  });

  it("posts to /v1/logs with the bearer token, and says plainly when the token is rejected", async () => {
    const seen: { url?: string; auth?: string; body: string }[] = [];
    let status = 200;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body });
        res.statusCode = status;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const h = setup({ SESH_URL: `http://127.0.0.1:${port}`, SESH_TOKEN: "tok-1" });
      const ok = await h.sesh("upload", "s-up");
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain("Sent 5 events from 2 turns");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ url: "/v1/logs", auth: "Bearer tok-1" });
      expect(seen[0]!.body).not.toContain(SECRET);

      status = 401;
      const denied = await h.sesh("upload", "s-up");
      expect(denied.code).toBe(1);
      expect(denied.stderr).toContain("rejected the token (401)");

      seen.length = 0;
      const dry = await h.sesh("upload", "s-up", "--dry-run");
      expect(dry.code).toBe(0);
      expect(seen).toHaveLength(0);
      expect(logsOf(JSON.parse(dry.stdout)).resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(5);
    } finally {
      server.close();
    }
  });

  it("fails clearly with no config, no session id or an unknown session; dry-run needs no config", async () => {
    const h = setup();
    const none = await h.sesh("upload", "s-up");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No sesh to send to");
    expect((await h.sesh("upload")).stderr).toContain("Usage: sesh upload");
    const missing = await home({ SESH_NO_UPDATE: "1", SESH_URL: "http://127.0.0.1:1", SESH_TOKEN: "t" }).sesh(
      "upload",
      "nope",
    );
    expect(missing.stderr).toContain("No Claude Code session nope");
    expect((await h.sesh("upload", "s-up", "--dry-run")).code).toBe(0);
  });

  const summary = (project: string, id: string, startedAt: string | null) => ({
    id,
    started_at: startedAt,
    project,
    prompts: 1,
    tokens: 1,
  });
  const many = [
    summary("/work/app", "a", "2026-10-03T00:00:00.000Z"),
    summary("/work/api", "b", "2026-10-01T00:00:00.000Z"),
    summary("/other/app", "c", "2026-09-01T00:00:00.000Z"),
    summary("/work/app", "d", null),
  ];
  const ids = (s: { id: string }[]) => s.map((x) => x.id);

  it("selects sessions with --all, --since and --project, and nothing without one", () => {
    expect(ids(selectSessions(many, { all: true }))).toEqual(["a", "b", "c", "d"]);
    expect(ids(selectSessions(many))).toEqual([]);
    expect(ids(selectSessions(many, { since: "2026-10-01" }))).toEqual(["a", "b"]);
    expect(ids(selectSessions(many, { project: "app" }))).toEqual(["a", "c", "d"]);
    expect(ids(selectSessions(many, { since: "2026-09-15", project: "/work/app" }))).toEqual(["a"]);
    expect(() => selectSessions(many, { since: "last week" })).toThrow("--since needs a date");
  });

  it("reads a pick like 1,3-4 or all, and refuses what is not on the list", () => {
    expect(parseChoice("1, 3-4", 5)).toEqual([0, 2, 3]);
    expect(parseChoice("all", 3)).toEqual([0, 1, 2]);
    expect(parseChoice("3 1 1", 3)).toEqual([0, 2]);
    for (const bad of ["0", "6", "4-2", "x", "1-9"]) expect(parseChoice(bad, 5)).toBeNull();
  });

  it("scans the transcript files each session spans, and reads only those", () => {
    const h = setup();
    const found = scanSessions(h.env).find((s) => s.id === "s-up")!;
    expect(found.files).toEqual([join(h.root, ".claude", "projects", "-work-app", "s-up.jsonl")]);
    expect(readSessionEntries("s-up", h.env, found.files).length).toBe(readSessionEntries("s-up", h.env).length);
    expect(readSessionEntries("s-up", h.env, [])).toEqual([]);
  });

  it("reads each transcript at most twice in a bulk run, however many sessions there are", async () => {
    const h = setup();
    const dir = join(h.root, ".claude", "projects", "-work-app");
    for (let i = 0; i < 30; i++) {
      const line = JSON.stringify({
        type: "user",
        sessionId: `s-${i}`,
        cwd: "/work/app",
        timestamp: "2026-10-02T10:00:00.000Z",
        message: { content: `prompt ${i}` },
      });
      writeFileSync(join(dir, `s-${i}.jsonl`), line);
    }
    // Counts the transcript reads in the run by wrapping fs.readFileSync before sesh loads.
    const log = join(h.root, "reads.log");
    const preload = join(h.root, "count-reads.cjs");
    writeFileSync(
      preload,
      `const fs = require("node:fs");
const read = fs.readFileSync;
fs.readFileSync = (f, ...a) => {
  if (String(f).endsWith(".jsonl")) fs.appendFileSync(${JSON.stringify(log)}, f + "\\n");
  return read(f, ...a);
};`,
    );
    await run(process.execPath, ["--require", preload, join(h.state, "sesh.mjs"), "upload", "--all", "--dry-run"], {
      env: h.env,
    });
    const reads = new Map<string, number>();
    for (const f of readFileSync(log, "utf8").split("\n").filter(Boolean)) reads.set(f, (reads.get(f) ?? 0) + 1);
    expect(reads.size).toBe(31);
    // Once to list the sessions and once to build the chosen ones: never once per session.
    expect(Math.max(...reads.values())).toBeLessThanOrEqual(2);
  });

  it("shows progress with the time left", () => {
    expect(progressLine(0, 10, 0)).toBe("0/10 sessions (0s so far)");
    expect(progressLine(250, 1000, 100_000)).toBe("250/1000 sessions (1m40s so far, about 5m00s left)");
    expect(progressLine(1000, 1000, 400_000)).toBe("1000/1000 sessions (6m40s so far)");
  });

  it("summarises accepted, skipped and failed", () => {
    expect(uploadSummary({ sent: 2, accepted: 5, skipped: 3, failed: 1, events: 40 })).toBe(
      "Sent 2 sessions (40 events): 5 turns accepted, 3 already known, 1 session failed.",
    );
  });

  it("uploads the chosen sessions, reports accepted and skipped, and goes on past a failure", async () => {
    const known = new Set<string>();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        expect(req.headers["content-encoding"]).toBe("gzip");
        const body = gunzipSync(Buffer.concat(chunks)).toString("utf8");
        if (body.includes('"s-bad"')) {
          res.statusCode = 500;
          return void res.end("{}");
        }
        let accepted = 0;
        let skipped = 0;
        const turns = new Set(
          [
            ...body.matchAll(
              /"key":"session\.id","value":\{"stringValue":"([^"]+)"\}\},\{"key":"prompt\.id","value":\{"stringValue":"([^"]+)"/g,
            ),
          ].map((m) => `${m[1]}/${m[2]}`),
        );
        for (const t of turns) {
          if (known.has(t)) skipped++;
          else {
            known.add(t);
            accepted++;
          }
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ sesh: { turns_accepted: accepted, turns_skipped: skipped } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const h = setup({ SESH_URL: `http://127.0.0.1:${port}`, SESH_TOKEN: "tok-1" });
      const dir = join(h.root, ".claude", "projects", "-other");
      mkdirSync(dir, { recursive: true });
      const other = (id: string) =>
        [
          line({
            type: "user",
            uuid: `${id}-u`,
            promptId: `${id}-p`,
            sessionId: id,
            cwd: "/other/place",
            timestamp: "2026-09-01T10:00:00.000Z",
            message: { content: "hi" },
          }),
        ].join("\n");
      writeFileSync(join(dir, "s-bad.jsonl"), other("s-bad"));
      writeFileSync(join(dir, "s-two.jsonl"), other("s-two"));

      const first = await h.sesh("upload", "--all");
      expect(first.code).toBe(1);
      expect(first.stderr).toContain("s-bad: failed: sesh answered 500");
      expect(first.stdout).toContain(
        "Sent 2 sessions (6 events): 3 turns accepted, 0 already known, 1 session failed.",
      );

      // s-up went through and is unchanged, so a plain re-run leaves it out; --force sends it again.
      const skip = await h.sesh("upload", "--project", "/work/app");
      expect(skip.code).toBe(0);
      expect(skip.stderr).toContain("1 of 1 sessions are already uploaded and unchanged");
      expect(skip.stdout).toContain("Sent 0 sessions (0 events)");
      expect(skip.stdout).toContain("1 already uploaded was left out");

      const again = await h.sesh("upload", "--project", "/work/app", "--force");
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("1 session (5 events): 0 turns accepted, 2 already known, 0 sessions failed.");

      const dry = await h.sesh("upload", "--since", "2026-09-15", "--dry-run");
      expect(dry.code).toBe(0);
      expect(dry.stderr).toContain("Dry run: 5 events from 1 session");
    } finally {
      server.close();
    }
  });

  it("without a terminal and without flags, or with a bad flag, exits with a usage message", async () => {
    const h = setup({ SESH_URL: "http://127.0.0.1:1", SESH_TOKEN: "t" });
    const bare = await h.sesh("upload");
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("Usage: sesh upload");
    expect((await h.sesh("upload", "s-up", "--all")).stderr).toContain("Usage: sesh upload");
    expect((await h.sesh("upload", "--since")).stderr).toContain("Usage: sesh upload");
    expect((await h.sesh("upload", "--since", "soon")).stderr).toContain("--since needs a date");
    const none = await h.sesh("upload", "--project", "/nowhere");
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("No sessions selected");
  });

  it("posts to the server's /v1/logs whatever path the saved url has", () => {
    expect(logsUrl({ url: "https://sesh.example/v1/limits", token: "t" })).toBe("https://sesh.example/v1/logs");
    expect(logsUrl({ url: "https://x.example/otel/v1/limits", token: "t" })).toBe("https://x.example/otel/v1/logs");
    expect(logsUrl(null)).toBeNull();
  });

  it("tags every metrics event with product sesh and app sesh-cli", async () => {
    expect(IDENTITY).toEqual({ product: "sesh", app: "sesh-cli" });
    const h = home();
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response("{}");
    }) as unknown as typeof fetch;
    await capture("cli_command_failed", { command: "upload" }, { env: { SESH_STATE_DIR: h.state }, fetchFn });
    await capture("cli_command_succeeded", {}, { env: { SESH_STATE_DIR: h.state, POSTHOG_API_KEY: "phc_x" }, fetchFn });
    expect(sent).toHaveLength(2);
    const [first, second] = sent as [(typeof sent)[number], (typeof sent)[number]];
    expect(first.url).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(first.body).toMatchObject({
      event: "cli_command_failed",
      properties: { command: "upload", product: "sesh", app: "sesh-cli", cli_version: VERSION },
    });
    expect(second.body.api_key).toBe("phc_x");
    // the same install keeps one id
    expect(second.body.distinct_id).toBe(first.body.distinct_id);
  });

  it("sends no metrics with DO_NOT_TRACK or SESH_TELEMETRY=0, and never throws", async () => {
    expect(metricsOff({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(metricsOff({ DO_NOT_TRACK: "0" })).toBe(false);
    expect(metricsOff({ SESH_TELEMETRY: "0" })).toBe(true);
    const h = home();
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await capture("x", {}, { env: { SESH_STATE_DIR: h.state, DO_NOT_TRACK: "1" }, fetchFn });
    expect(calls).toBe(0);
    await expect(capture("x", {}, { env: { SESH_STATE_DIR: h.state }, fetchFn })).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });
});
