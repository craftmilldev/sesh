import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCliRoutes } from "../src/cli.js";

const VERSION = /VERSION = "([^"]+)"/.exec(readFileSync(new URL("../cli/sesh.mjs", import.meta.url), "utf8"))![1];

// Vercel uploads only packages/web, so the server serves its own copy of the CLI, which lives in packages/cli.
describe("the CLI copy in packages/web", () => {
  it("is the same file as packages/cli/sesh.mjs (run `npm run sync -w @sesh/cli` after changing it)", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(read("../cli/sesh.mjs")).toBe(read("../../cli/sesh.mjs"));
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
