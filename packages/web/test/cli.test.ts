import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCliRoutes } from "../src/cli.js";
import { isSeshCommand, serverOrigin, updatesEnabled, VERSION } from "../cli/sesh.mjs";

const run = promisify(execFile);
const SOURCE = new URL("../cli/sesh.mjs", import.meta.url).pathname;

/** An installed sesh in a temp home: ~/.sesh/sesh.mjs and a Claude config dir, as `sesh` sees them. */
function home(script = SOURCE) {
  const root = mkdtempSync(join(tmpdir(), "sesh-cli-"));
  const state = join(root, ".sesh");
  mkdirSync(state);
  copyFileSync(script, join(state, "sesh.mjs"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    SESH_STATE_DIR: state,
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
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
  let sha256: string;
  const hits: string[] = [];

  beforeAll(async () => {
    const { createHash } = await import("node:crypto");
    served = Buffer.from(readFileSync(SOURCE, "utf8").replace(`VERSION = "${VERSION}"`, 'VERSION = "9.9.9"'));
    sha256 = createHash("sha256").update(served).digest("hex");
    server = createServer((req, res) => {
      hits.push(`${req.url} ${String(req.headers["x-sesh-cli-version"])}`);
      if (req.url === "/cli/version") res.end(JSON.stringify({ version: "9.9.9", sha256 }));
      else if (req.url === "/cli/sesh.mjs") res.end(served);
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => void server.close());

  it("an installed copy installs the server's version before a command and runs the command on it", async () => {
    const h = home();
    writeFileSync(join(h.state, "config.json"), JSON.stringify({ url: `${origin}/v1/limits`, token: "tok_abcdefgh" }));
    const out = await h.sesh("--version");
    // --version is answered without updating; any other command updates first
    expect(out.stdout.trim()).toBe(VERSION);
    const status = await h.sesh("status");
    expect(status.stderr).toContain(`Updating sesh ${VERSION} → 9.9.9`);
    expect(status.stdout).toContain("sesh:         9.9.9");
    expect(readFileSync(join(h.state, "sesh.mjs"), "utf8")).toContain('VERSION = "9.9.9"');
    expect(hits).toContain(`/cli/sesh.mjs ${VERSION}`);
  });

  it("does not update with auto_update off, or when it isn't the installed copy", async () => {
    const h = home();
    writeFileSync(join(h.state, "config.json"), JSON.stringify({ url: `${origin}/v1/limits`, token: "tok_abcdefgh" }));
    writeFileSync(
      join(h.state, "config.json"),
      JSON.stringify({ url: `${origin}/v1/limits`, token: "tok_abcdefgh", auto_update: false }),
    );
    const status = await h.sesh("status");
    expect(status.stderr).not.toContain("Updating");
    expect(status.stdout).toContain(`sesh:         ${VERSION}`);
    const checkout = await run(process.execPath, [SOURCE, "update"], {
      env: { ...h.env, SESH_STATE_DIR: h.state },
    }).catch((e: { stderr: string }) => e);
    expect(checkout).toMatchObject({ stderr: expect.stringContaining("can't update itself") as string });
  });

  it("refuses a download that isn't the announced version and keeps the working copy", async () => {
    const h = home();
    writeFileSync(join(h.state, "config.json"), JSON.stringify({ url: `${origin}/v1/limits`, token: "tok_abcdefgh" }));
    const real = served;
    served = Buffer.from("console.log('evil')");
    try {
      const status = await h.sesh("status");
      expect(status.stderr).toContain("isn't the version the server announced");
      expect(status.stdout).toContain(`sesh:         ${VERSION}`);
      expect(readFileSync(join(h.state, "sesh.mjs"), "utf8")).not.toContain("evil");
    } finally {
      served = real;
    }
  });

  it("reads the server from config or SESH_URL, and updates only the installed copy", () => {
    expect(serverOrigin({}, { url: "https://a.test/v1/limits", token: "t" })).toBe("https://a.test");
    expect(serverOrigin({ SESH_URL: "https://b.test/x" }, null)).toBe("https://b.test");
    expect(serverOrigin({}, null)).toBe("https://sesh.craftmill.dev");
    expect(updatesEnabled({ SESH_STATE_DIR: "/x" }, "/x/sesh.mjs", {})).toBe(true);
    expect(updatesEnabled({ SESH_STATE_DIR: "/x" }, "/repo/cli/sesh.mjs", {})).toBe(false);
    expect(updatesEnabled({ SESH_STATE_DIR: "/x", SESH_NO_UPDATE: "1" }, "/x/sesh.mjs", {})).toBe(false);
    expect(updatesEnabled({ SESH_STATE_DIR: "/x" }, "/x/sesh.mjs", { auto_update: false })).toBe(false);
  });
});

describe("serving the CLI", () => {
  const events: { event: string; properties?: Record<string, unknown> }[] = [];
  const app = createCliRoutes({
    metrics: { capture: async (event, _id, properties) => void events.push({ event, properties }) },
  });

  it("announces the version and hash of the file it serves, and counts who asked", async () => {
    const info = (await (await app.request("/cli/version", { headers: { "x-sesh-cli-version": "0.0.1" } })).json()) as {
      version: string;
      sha256: string;
    };
    const body = Buffer.from(await (await app.request("/cli/sesh.mjs")).arrayBuffer());
    expect(info.version).toBe(VERSION);
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(body).digest("hex")).toBe(info.sha256);
    expect(events).toEqual([
      { event: "cli_version_checked", properties: { from_version: "0.0.1", current: false } },
      { event: "cli_downloaded", properties: { kind: "install", from_version: undefined, version: VERSION } },
    ]);
  });

  it("records a junk version header as unknown", async () => {
    events.length = 0;
    await app.request("/cli/sesh.mjs", { headers: { "x-sesh-cli-version": "evil<script>" } });
    expect(events[0]?.properties).toMatchObject({ kind: "update", from_version: "unknown" });
  });

  it("serves install.sh pointed at the server it came from", async () => {
    const res = await app.request("http://sesh.test/install.sh");
    const text = await res.text();
    expect(text).toContain('SERVER="${SESH_SERVER:-http://sesh.test}"');
    expect(text).not.toContain("__SESH_SERVER__");
    expect(events.at(-1)?.event).toBe("install_script_fetched");
  });
});
