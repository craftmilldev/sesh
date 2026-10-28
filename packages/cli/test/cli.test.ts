import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  formatBar,
  isNewer,
  isSeshCommand,
  parseInput,
  parseTranscript,
  readConfig,
  releaseVersion,
  reportable,
  scanSessions,
  serverOrigin,
  target,
  updatesEnabled,
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
