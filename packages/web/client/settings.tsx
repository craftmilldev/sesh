import { useCallback, useEffect, useState, type FormEvent } from "react";
import { message, type Me, type Org } from "./layout.js";
import { api, saveOrg } from "./session.js";

interface Token {
  id: string;
  name: string;
  created_at?: string;
}
interface Member {
  name: string;
  role: "owner" | "member";
  counts_toward_team: boolean;
}

function Field(props: {
  label: string;
  button: string;
  type: "text" | "email";
  max?: number;
  primary?: boolean;
  placeholder?: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    await props.onSubmit(value);
    setValue("");
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <label>
        {props.label}
        <input
          type={props.type}
          value={value}
          maxLength={props.max}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
          required
        />
      </label>
      <button type="submit" className={props.primary ? "primary" : undefined}>
        {props.button}
      </button>
    </form>
  );
}

function SwitchOrg({ orgs, active, onSwitch }: { orgs: Org[]; active: string; onSwitch: (id: string) => void }) {
  const [picked, setPicked] = useState(active);
  return (
    <div className="form">
      <label>
        Switch org
        <select value={picked} onChange={(e) => setPicked(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => onSwitch(picked)}>
        Switch
      </button>
    </div>
  );
}

/** Org and tokens: everything that is not sessions. */
export function Settings({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const { org, orgs } = me;
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [members, setMembers] = useState<Member[]>([]);

  const loadMembers = useCallback(async () => setMembers((await api<{ members: Member[] }>("/members")).members), []);
  useEffect(() => {
    loadMembers().catch((err) => setNotice({ text: message(err), error: true }));
  }, [loadMembers]);

  /** Runs an action, then reloads; a failure is shown instead. */
  async function act(run: () => Promise<string | void>) {
    setNotice(undefined);
    try {
      const text = await run();
      await reload();
      if (text) setNotice({ text });
    } catch (err) {
      setNotice({ text: message(err), error: true });
    }
  }

  return (
    <>
      <section className="section">
        <p className="eyebrow">
          {org.name} · {org.role === "owner" ? "You own this org" : "Member"}
        </p>
        <h1>Org and tokens</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          Who is in {org.name}, and the tokens that let Claude Code send it session events.
        </p>
        {notice && <p className={notice.error ? "notice error" : "notice"}>{notice.text}</p>}
      </section>

      <section className="section">
        <p className="eyebrow">Section I · The org</p>
        <h2>{org.name}</h2>
        <ul className="rows" style={{ marginTop: 16 }}>
          {members.map((m, i) => (
            <li key={i}>
              <span>{m.name}</span>
              <span>
                {!m.counts_toward_team && <span className="meta">observer · </span>}
                <span className={`role ${m.role}`}>{m.role}</span>
              </span>
            </li>
          ))}
        </ul>
        <label>
          <input
            type="checkbox"
            checked={org.counts_toward_team}
            onChange={(e) =>
              void act(async () => {
                const r = await api<{ tokens_revoked: number }>("/membership", {
                  body: { counts_toward_team: e.target.checked },
                });
                return e.target.checked
                  ? `You now count toward ${org.name}'s team.`
                  : `You're an observer in ${org.name}. ${r.tokens_revoked} token(s) revoked.`;
              })
            }
          />{" "}
          I count toward this team
        </label>
        <p className="muted">
          Turn this off to only look. You drop out of the plan pool, your tokens for {org.name} are revoked and you
          can't make new ones.
        </p>
        {org.role === "owner" && (
          <>
            <Field
              label="Invite by email"
              button="Send invite"
              type="email"
              primary
              onSubmit={(email) =>
                act(async () => {
                  const r = await api<{ email: string; ttl_days: number }>("/orgs/invite", { body: { email } });
                  return `Invite sent to ${r.email}. The link works once and expires in ${r.ttl_days} days.`;
                })
              }
            />
            <p className="muted">The link works once and lasts seven days.</p>
          </>
        )}
        {orgs.length > 1 && (
          <SwitchOrg
            orgs={orgs}
            active={org.id}
            onSwitch={(id) =>
              void act(async () => {
                await api("/orgs/switch", { body: { org: id } });
                saveOrg(id);
              })
            }
          />
        )}
        <Field
          label="New org"
          button="Create"
          type="text"
          max={80}
          onSubmit={(name) =>
            act(async () => {
              const r = await api<{ org: { id: string } }>("/orgs", { body: { name } });
              saveOrg(r.org.id);
            })
          }
        />
      </section>

      {org.counts_toward_team ? (
        <Tokens org={org} endpoint={me.ingest_endpoint} />
      ) : (
        <section className="section">
          <p className="eyebrow">Section II · Ingest</p>
          <h2>Ingest tokens for {org.name}</h2>
          <p className="muted">You're an observer here, so you can't make tokens or send data.</p>
        </section>
      )}
    </>
  );
}

function Tokens({ org, endpoint }: { org: Org; endpoint: string }) {
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
      <p className="eyebrow">Section II · Ingest</p>
      <h2>Ingest tokens for {org.name}</h2>
      {error && <p className="notice error">{error}</p>}
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
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="laptop" />
        </label>
        <button type="submit" className="primary">
          Create token
        </button>
      </form>
      <div className="panel">
        <span className="label">Set these where Claude Code runs</span>
        {snippet(created ?? "<your token>")}
      </div>
      <p className="muted">
        Plan usage comes from the Claude Code status line: add the sesh status line script to{" "}
        <code>~/.claude/settings.json</code>. Headless <code>claude -p</code> never runs it, so it never reports plan
        usage.
      </p>
    </section>
  );
}
