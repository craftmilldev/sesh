import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Sessions } from "./sessions.js";
import { api, ApiError, clearSession, getToken, saveOrg } from "./session.js";

interface Org {
  id: string;
  name: string;
  role: "owner" | "member";
}
interface Me {
  user: { name: string };
  org: Org;
  orgs: Org[];
  ingest_endpoint: string;
}
interface Token {
  id: string;
  name: string;
}

const message = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong.");

export function App() {
  const [me, setMe] = useState<Me>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();

  const load = useCallback(async () => setMe(await api<Me>("/me")), []);
  useEffect(() => {
    if (!getToken()) return location.replace("/login");
    load().catch((err) => setNotice({ text: message(err), error: true }));
  }, [load]);

  /** Runs an action, then reloads; a failure is shown instead. */
  async function act(run: () => Promise<string | void>) {
    setNotice(undefined);
    try {
      const text = await run();
      await load();
      if (text) setNotice({ text });
    } catch (err) {
      setNotice({ text: message(err), error: true });
    }
  }

  if (!me) return notice ? <p className="error">{notice.text}</p> : null;
  const { org, orgs } = me;

  return (
    <>
      <h1>sesh</h1>
      <p>
        Signed in as <strong>{me.user.name}</strong>.
      </p>
      <p>
        Org: <strong>{org.name}</strong> ({org.role})
      </p>
      {notice && <p className={notice.error ? "error" : undefined}>{notice.text}</p>}
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
      <NameForm
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
      {org.role === "owner" && (
        <NameForm
          label="Invite by email"
          button={`Send invite to ${org.name}`}
          type="email"
          onSubmit={(email) =>
            act(async () => {
              const r = await api<{ email: string; ttl_days: number }>("/orgs/invite", { body: { email } });
              return `Invite sent to ${r.email}. The link works once and expires in ${r.ttl_days} days.`;
            })
          }
        />
      )}
      <Sessions key={org.id} orgName={org.name} />
      <Tokens key={org.id} org={org} endpoint={me.ingest_endpoint} />
      <p>
        <button
          type="button"
          onClick={() => {
            // Best effort: it only records the sign-out, and the session ends here either way.
            void api("/logout", { body: {} }).catch(() => undefined);
            clearSession();
            location.replace("/");
          }}
        >
          Sign out
        </button>
      </p>
    </>
  );
}

function SwitchOrg({ orgs, active, onSwitch }: { orgs: Org[]; active: string; onSwitch: (id: string) => void }) {
  const [picked, setPicked] = useState(active);
  return (
    <p>
      <label>
        Switch org{" "}
        <select value={picked} onChange={(e) => setPicked(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>{" "}
      <button type="button" onClick={() => onSwitch(picked)}>
        Switch
      </button>
    </p>
  );
}

function NameForm(props: {
  label: string;
  button: string;
  type: "text" | "email";
  max?: number;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    await props.onSubmit(value);
    setValue("");
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <label>
        {props.label}{" "}
        <input
          type={props.type}
          value={value}
          maxLength={props.max}
          onChange={(e) => setValue(e.target.value)}
          required
        />
      </label>{" "}
      <button type="submit">{props.button}</button>
    </form>
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
    <>
      <h2>Ingest tokens for {org.name}</h2>
      {error && <p className="error">{error}</p>}
      {created ? (
        <>
          <p>Your new token. Copy it now; it is never shown again. Set these in the environment Claude Code runs in:</p>
          <pre>{snippet(created)}</pre>
        </>
      ) : (
        tokens.length > 0 && (
          <>
            <p>Point Claude Code at sesh with these (use a token you saved, or make a new one):</p>
            <pre>{snippet("<your token>")}</pre>
          </>
        )
      )}
      <ul>
        {tokens.map((t) => (
          <li key={t.id}>
            {t.name}{" "}
            <button type="button" onClick={() => void run(() => api(`/tokens/${t.id}/revoke`, { body: {} }))}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setCreated((await api<{ token: string }>("/tokens", { body: { name } })).token);
            setName("");
          });
        }}
      >
        <label>
          New token{" "}
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="laptop" />
        </label>{" "}
        <button type="submit">Create</button>
      </form>
    </>
  );
}
