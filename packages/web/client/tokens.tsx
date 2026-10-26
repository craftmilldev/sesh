import { useCallback, useEffect, useState } from "react";
import { message, type Me } from "./layout.js";
import { api } from "./session.js";

interface Token {
  id: string;
  name: string;
  created_at?: string;
}

/** Tokens: the ingest tokens that let Claude Code send the org its session events. */
export function Tokens({ me }: { me: Me }) {
  const { org, ingest_endpoint: endpoint } = me;
  const [tokens, setTokens] = useState<Token[]>([]);
  const [created, setCreated] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(async () => setTokens((await api<{ tokens: Token[] }>("/tokens")).tokens), []);
  useEffect(() => {
    load().catch((err) => setError(message(err)));
  }, [load]);

  async function run(action: () => Promise<void>) {
    setError(undefined);
    try {
      await action();
      await load();
    } catch (err) {
      setError(message(err));
    }
  }

  const snippet = (token: string) => `CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${token}"`;

  return (
    <section className="section">
      <p className="eyebrow">{org.name} · Ingest</p>
      <h1>Tokens</h1>
      <p className="muted" style={{ marginTop: 12 }}>
        Your tokens let Claude Code send {org.name} its session events. Make one per machine, and revoke it when the
        machine is gone.
      </p>
      {error && <p className="notice error">{error}</p>}
      {!org.counts_toward_team ? (
        <p className="muted">You're an observer here, so you can't make tokens or send data.</p>
      ) : (
        <>
          {created && (
            <div className="fresh">
              <span className="label">Copy it now · it will not be shown again</span>
              <code>{created}</code>
            </div>
          )}
          <ul className="rows" style={{ marginTop: 16 }}>
            {tokens.map((t) => (
              <li key={t.id}>
                <span>
                  {t.name}
                  {t.created_at && <span className="meta"> · made {new Date(t.created_at).toLocaleDateString()}</span>}
                </span>
                <button type="button" onClick={() => void run(() => api(`/tokens/${t.id}/revoke`, { body: {} }))}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setCreated((await api<{ token: string }>("/tokens", { body: { name } })).token);
                setName("");
              });
            }}
          >
            <label>
              New token
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
                placeholder="laptop"
              />
            </label>
            <button type="submit" className="primary">
              Create token
            </button>
          </form>
          <div className="panel">
            <span className="label">Set these where Claude Code runs</span>
            {snippet(created ?? "<your token>")}
          </div>
        </>
      )}
      <p className="muted">
        Plan usage comes from the Claude Code status line: add the sesh status line script to{" "}
        <code>~/.claude/settings.json</code>. Headless <code>claude -p</code> never runs it, so it never reports plan
        usage.
      </p>
    </section>
  );
}
