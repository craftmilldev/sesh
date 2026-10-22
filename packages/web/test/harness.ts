import { expect } from "vitest";
import { createApp } from "../src/api.js";
import type { Db } from "../src/db/index.js";
import type { Email } from "../src/email.js";
import type { Metrics } from "../src/metrics.js";

export const SECRET = "test-secret";

/** What a signed-in browser holds: the session token and, once it has picked one, the active org. */
export interface Session {
  token: string;
  org?: string;
}

/** An app over the test database, with the events it recorded and the emails it sent. */
export function setupApp(db: Db) {
  const events: { event: string; distinctId: string; properties?: Record<string, unknown> }[] = [];
  const emails: Email[] = [];
  const metrics: Metrics = {
    capture: async (event, distinctId, properties) => void events.push({ event, distinctId, properties }),
  };
  const app = createApp({
    getDb: async () => db,
    tokenSecret: SECRET,
    metrics,
    sendEmail: async (e) => void emails.push(e),
  });
  /** Calls the JSON API: a POST with a JSON body when `body` is given, else a GET. */
  const call = (path: string, opts: { body?: unknown; session?: Session; headers?: Record<string, string> } = {}) =>
    app.request(`/api${path}`, {
      method: opts.body === undefined ? "GET" : "POST",
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.session ? { authorization: `Bearer ${opts.session.token}` } : {}),
        ...(opts.session?.org ? { "x-sesh-org": opts.session.org } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  const codeFrom = (e: Email) => /code is ([0-9A-Z]{8})/.exec(e.text)![1]!;
  /** Runs the whole sign-in and returns the session. */
  async function signIn(email: string): Promise<Session> {
    await call("/login", { body: { email } });
    const res = await call("/login/verify", { body: { email, code: codeFrom(emails.at(-1)!) } });
    expect(res.status).toBe(200);
    return { token: ((await res.json()) as { token: string }).token };
  }
  return { app, events, emails, call, signIn, codeFrom };
}
