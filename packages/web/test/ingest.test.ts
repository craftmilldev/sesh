import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api.js";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import type { Email } from "../src/email.js";
import type { Metrics } from "../src/metrics.js";

let db: Db;
beforeAll(async () => {
  db = await openTestDb();
});
afterAll(async () => {
  await db.close();
});

function setup() {
  const events: { event: string; distinctId: string; properties?: Record<string, unknown> }[] = [];
  const emails: Email[] = [];
  const metrics: Metrics = {
    capture: async (event, distinctId, properties) => void events.push({ event, distinctId, properties }),
  };
  const app = createApp({
    getDb: async () => db,
    tokenSecret: "test-secret",
    metrics,
    sendEmail: async (e) => void emails.push(e),
  });
  const form = (path: string, fields: Record<string, string>, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields).toString(),
    });
  async function signIn(email: string) {
    await form("/login", { email });
    const code = /code is ([0-9A-Z]{8})/.exec(emails.at(-1)!.text)![1]!;
    const res = await form("/login/verify", { email, code });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }
  /** Makes a token as the signed-in user and returns the secret from the page that shows it once. */
  async function makeToken(cookie: string, name = "work-mac") {
    const res = await form("/app/tokens", { name }, cookie);
    expect(res.status).toBe(200);
    return /Bearer (sesh_[\w-]+)/.exec(await res.text())![1]!;
  }
  const post = (path: string, body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { app, events, form, signIn, makeToken, post };
}

const count = async (sql: string) => Number((await db.query<{ n: string }>(sql))[0]!.n);
const payloads = (email: string) =>
  db.query<{ signal: string; org_name: string; body: Buffer; content_encoding: string | null }>(
    `SELECT p.signal, o.name AS org_name, p.body, p.content_encoding FROM sesh.raw_payloads p
     JOIN sesh.users u ON u.id = p.user_id JOIN sesh.orgs o ON o.id = p.org_id WHERE u.email = $1 ORDER BY p.id`,
    [email],
  );

describe("tokens", () => {
  it("shows a new token once, stores only its hash, lists it and revokes it", async () => {
    const t = setup();
    const cookie = await t.signIn("tok1@example.com");
    const token = await t.makeToken(cookie, "work-mac");
    expect(await count(`SELECT count(*) AS n FROM sesh.ingest_tokens WHERE token_hash = '${token}'`)).toBe(0);

    const page = await (await t.app.request("/app", { headers: { cookie } })).text();
    expect(page).toContain("work-mac");
    expect(page).not.toContain(token);
    expect(page).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost");

    const [row] = await db.query<{ id: string }>(
      `SELECT t.id FROM sesh.ingest_tokens t JOIN sesh.users u ON u.id = t.user_id WHERE u.email = 'tok1@example.com'`,
    );
    expect((await t.form(`/app/tokens/${row!.id}/revoke`, {}, cookie)).status).toBe(302);
    expect((await t.form(`/app/tokens/${row!.id}/revoke`, {}, cookie)).status).toBe(404);
    expect((await t.form(`/app/tokens/not-a-uuid/revoke`, {}, cookie)).status).toBe(404);
    expect(await (await t.app.request("/app", { headers: { cookie } })).text()).not.toContain("work-mac");
    expect(t.events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["token_created", "token_revoked", "token_revoke_rejected"]),
    );
  });

  it("rejects an empty name and requires sign-in", async () => {
    const t = setup();
    const cookie = await t.signIn("tok2@example.com");
    expect((await t.form("/app/tokens", { name: "" }, cookie)).status).toBe(400);
    expect(t.events.find((e) => e.event === "token_create_rejected")!.properties).toEqual({ reason: "empty_name" });
    expect((await t.form("/app/tokens", { name: "x" })).status).toBe(302);
  });

  it("won't let another user revoke a token", async () => {
    const t = setup();
    const owner = await t.signIn("tok3@example.com");
    await t.makeToken(owner);
    const other = await t.signIn("tok4@example.com");
    const [row] = await db.query<{ id: string }>(
      `SELECT t.id FROM sesh.ingest_tokens t JOIN sesh.users u ON u.id = t.user_id WHERE u.email = 'tok3@example.com'`,
    );
    expect((await t.form(`/app/tokens/${row!.id}/revoke`, {}, other)).status).toBe(404);
    expect(
      await count(`SELECT count(*) AS n FROM sesh.ingest_tokens WHERE id = '${row!.id}' AND revoked_at IS NULL`),
    ).toBe(1);
  });
});

describe("OTLP ingest", () => {
  const logs = JSON.stringify({ resourceLogs: [] });

  it("stores a JSON payload against the token's org and user, for both signals", async () => {
    const t = setup();
    const token = await t.makeToken(await t.signIn("ing1@example.com"));
    const auth = { authorization: `Bearer ${token}` };
    const a = await t.post("/v1/logs", logs, auth);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({});
    expect((await t.post("/v1/metrics", JSON.stringify({ resourceMetrics: [] }), auth)).status).toBe(200);
    const rows = await payloads("ing1@example.com");
    expect(rows.map((r) => [r.signal, r.org_name])).toEqual([
      ["logs", "ing1"],
      ["metrics", "ing1"],
    ]);
    expect(rows[0]!.body.toString()).toBe(logs);
    expect(t.events.filter((e) => e.event === "ingest_accepted").map((e) => e.properties)).toEqual([
      { signal: "logs", format: "json", gzip: false },
      { signal: "metrics", format: "json", gzip: false },
    ]);
  });

  it("stores protobuf and gzipped bodies untouched", async () => {
    const t = setup();
    const token = await t.makeToken(await t.signIn("ing2@example.com"));
    const auth = { authorization: `Bearer ${token}` };
    const proto = Uint8Array.from([0x0a, 0x00, 0xff, 0x80]);
    const res = await t.post("/v1/logs", proto, { ...auth, "content-type": "application/x-protobuf" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    const zipped = gzipSync(logs);
    expect((await t.post("/v1/logs", zipped, { ...auth, "content-encoding": "gzip" })).status).toBe(200);
    const rows = await payloads("ing2@example.com");
    expect([...rows[0]!.body]).toEqual([...proto]);
    expect(rows[1]!.content_encoding).toBe("gzip");
    expect([...rows[1]!.body]).toEqual([...zipped]);
  });

  it("answers 401 and stores nothing for a missing, wrong or revoked token", async () => {
    const t = setup();
    const cookie = await t.signIn("ing3@example.com");
    const token = await t.makeToken(cookie);
    expect((await t.post("/v1/logs", logs)).status).toBe(401);
    expect((await t.post("/v1/logs", logs, { authorization: "Bearer sesh_nope" })).status).toBe(401);
    expect((await t.post("/v1/logs", logs, { authorization: token })).status).toBe(401);
    const res = await t.post("/v1/logs", logs, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);

    const [row] = await db.query<{ id: string }>(
      `SELECT t.id FROM sesh.ingest_tokens t JOIN sesh.users u ON u.id = t.user_id WHERE u.email = 'ing3@example.com'`,
    );
    await t.form(`/app/tokens/${row!.id}/revoke`, {}, cookie);
    const revoked = await t.post("/v1/metrics", logs, { authorization: `Bearer ${token}` });
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toBe("Bearer");
    expect(await payloads("ing3@example.com")).toHaveLength(1);
    expect(t.events.filter((e) => e.event === "ingest_rejected").map((e) => e.properties!.reason)).toEqual([
      "missing_token",
      "invalid_token",
      "missing_token",
      "invalid_token",
    ]);
  });

  it("uses the org the token was made in, not the active one", async () => {
    const t = setup();
    const cookie = await t.signIn("ing4@example.com");
    const token = await t.makeToken(cookie);
    const made = await t.form("/app/orgs", { name: "Second Org" }, cookie);
    const other = `${cookie}; ${made.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ")}`;
    // The new org has no tokens of its own yet.
    expect(await (await t.app.request("/app", { headers: { cookie: other } })).text()).not.toContain("work-mac");
    await t.post("/v1/logs", logs, { authorization: `Bearer ${token}` });
    expect((await payloads("ing4@example.com")).map((r) => r.org_name)).toEqual(["ing4"]);
  });

  it("rejects bad payloads after auth and stores nothing", async () => {
    const t = setup();
    const token = await t.makeToken(await t.signIn("ing5@example.com"));
    const auth = { authorization: `Bearer ${token}` };
    expect((await t.post("/v1/logs", "{nope", auth)).status).toBe(400);
    expect((await t.post("/v1/logs", "", auth)).status).toBe(400);
    expect((await t.post("/v1/logs", "hi", { ...auth, "content-type": "text/plain" })).status).toBe(415);
    expect((await t.post("/v1/logs", logs, { ...auth, "content-encoding": "br" })).status).toBe(415);
    expect((await t.post("/v1/logs", "x".repeat(4 * 1024 * 1024 + 1), auth)).status).toBe(413);
    // No Content-Length (a chunked upload): the cap still holds.
    const chunked = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new Uint8Array(3 * 1024 * 1024));
        ctl.enqueue(new Uint8Array(2 * 1024 * 1024));
        ctl.close();
      },
    });
    const big = await t.app.request("/v1/logs", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: chunked,
      duplex: "half",
    } as RequestInit);
    expect(big.status).toBe(413);
    expect(await payloads("ing5@example.com")).toHaveLength(0);
    expect(t.events.filter((e) => e.event === "ingest_rejected").map((e) => e.properties!.reason)).toEqual([
      "invalid_json",
      "empty_body",
      "unsupported_content_type",
      "unsupported_encoding",
      "payload_too_large",
      "payload_too_large",
    ]);
  });
});
