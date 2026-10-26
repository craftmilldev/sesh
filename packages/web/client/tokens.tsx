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
  const [copied, setCopied] = useState(false);
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

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the token and copy it by hand.");
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
        <p className="muted">
          You only look at {org.name}, so you have no tokens here. Tick Counts on <a href="/app/members">Members</a> to
          make some.
        </p>
      ) : (
        <>
          {created && (
            <div className="fresh">
              <span className="label">Copy it now · it will not be shown again</span>
              <code>{created}</code>
              <button type="button" className="ghost" onClick={() => void copy(created)}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Made</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="num muted">{t.created_at && new Date(t.created_at).toLocaleDateString()}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void run(() => api(`/tokens/${t.id}/revoke`, { body: {} }))}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setCreated((await api<{ token: string }>("/tokens", { body: { name } })).token);
                setCopied(false);
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
          <div className="env">
            <span className="label">Set these where Claude Code runs</span>
            <div className="panel">{snippet(created ?? "<your token>")}</div>
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
