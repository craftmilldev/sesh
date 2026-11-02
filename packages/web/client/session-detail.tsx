import { useEffect, useState } from "react";
import { abbreviate, num, share } from "./fmt.js";
import { message } from "./layout.js";
import { api, getToken } from "./session.js";

interface Event {
  id: string;
  kind: "api_request" | "tool_call";
  occurred_at: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  tool_name: string | null;
  success: boolean | null;
}
interface Prompt {
  id: string;
  prompt_length: number | null;
  started_at: string;
  events: Event[];
}
interface Detail {
  session: {
    started_at: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    prompts: number;
    tool_calls: number;
  };
  prompts: Prompt[];
  unattributed_events: Event[];
}

const dash = (v: string | number | boolean | null) => (v == null ? "–" : String(v));
const tokensOf = (e: Event) =>
  (e.input_tokens ?? 0) + (e.output_tokens ?? 0) + (e.cache_read_tokens ?? 0) + (e.cache_write_tokens ?? 0);

/** "Thursday morning, from 10:43". */
function title(start: Date) {
  const h = start.getHours();
  const part = h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  const day = start.toLocaleDateString("en-US", { weekday: "long" });
  return `${day} ${part}, from ${h}:${String(start.getMinutes()).padStart(2, "0")}`;
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="figure">
      <div className="label">{label}</div>
      <div className="num">{value}</div>
      <p className="note">{note}</p>
    </div>
  );
}

/** The event's raw JSON, fetched the first time it is opened. */
function Raw({ sessionId, eventId }: { sessionId: string; eventId: string }) {
  const [raw, setRaw] = useState<string>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || raw !== undefined) return;
    api<{ raw: unknown }>(`/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(eventId)}/raw`).then(
      (r) => setRaw(JSON.stringify(r.raw, null, 2)),
      (e) => setRaw(message(e)),
    );
  }, [open, raw, sessionId, eventId]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>JSON</summary>
      {open && <pre className="panel">{raw ?? "Loading…"}</pre>}
    </details>
  );
}

function Events({ sessionId, events }: { sessionId: string; events: Event[] }) {
  if (!events.length) return <p className="muted">No events.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Kind</th>
            <th>Model or tool</th>
            <th>Result</th>
            <th className="num">Input</th>
            <th className="num">Output</th>
            <th className="num">Cache read</th>
            <th className="num">Cache write</th>
            <th className="num">Cost</th>
            <th className="num">ms</th>
            <th>Raw</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const result = e.kind === "tool_call" && e.success != null ? (e.success ? "ok" : "failed") : undefined;
            return (
              <tr key={e.id} className={result === "failed" ? "failed" : undefined}>
                <td>{new Date(e.occurred_at).toLocaleTimeString()}</td>
                <td className="muted">{e.kind}</td>
                <td>{e.kind === "tool_call" ? dash(e.tool_name) : dash(e.model)}</td>
                <td>{result ? <span className={`badge ${result}`}>{result}</span> : "–"}</td>
                <td className="num">{dash(e.input_tokens)}</td>
                <td className="num">{dash(e.output_tokens)}</td>
                <td className="num">{dash(e.cache_read_tokens)}</td>
                <td className="num">{dash(e.cache_write_tokens)}</td>
                <td className="num">{dash(e.cost_usd)}</td>
                <td className="num">{dash(e.duration_ms)}</td>
                <td>
                  <Raw sessionId={sessionId} eventId={e.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const [data, setData] = useState<Detail>();
  const [dayTokens, setDayTokens] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!getToken()) return location.replace("/login");
    api<Detail>(`/sessions/${encodeURIComponent(id)}`).then(
      (d) => {
        setData(d);
        const start = new Date(d.session.started_at);
        api<{ tokens: number }>(`/today?top=0&day=${start.toISOString().slice(0, 10)}`).then(
          (t) => setDayTokens(t.tokens),
          () => undefined, // the percentage is a nicety; the session itself is shown
        );
      },
      (e) => setError(message(e)),
    );
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  const { session } = data;
  const start = new Date(session.started_at);
  const total = session.input_tokens + session.output_tokens + session.cache_read_tokens + session.cache_write_tokens;
  const all = [...data.prompts.flatMap((p) => p.events), ...data.unattributed_events];
  const failed = all.filter((e) => e.kind === "tool_call" && e.success === false).length;
  const last = all.reduce((t, e) => Math.max(t, new Date(e.occurred_at).getTime()), start.getTime());
  const minutes = Math.max(1, Math.round((last - start.getTime()) / 60_000));

  return (
    <>
      <section className="section">
        <a className="back" href="/app">
          Back to sessions
        </a>
        <p className="eyebrow">Session · claude-code</p>
        <h1>{title(start)}</h1>
      </section>

      <section className="section">
        <div className="figures">
          <Figure
            label="Tokens"
            value={abbreviate(total)}
            note={dayTokens && total <= dayTokens ? `${share(total, dayTokens)} of that day` : "in the session"}
          />
          <Figure label="Cache hit" value={share(session.cache_read_tokens, total)} note="of all tokens" />
          <Figure label="Prompts" value={num(session.prompts)} note={`over ${minutes} min`} />
          <Figure label="Tool calls" value={num(session.tool_calls)} note={`${failed} failed`} />
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">In order</p>
        <h2>Prompts</h2>
        <div>
          {data.prompts.map((p, i) => {
            const t = p.events.reduce((n, e) => n + tokensOf(e), 0);
            return (
              <div className="prompt-row" key={p.id}>
                <span className="label">Prompt {i + 1}</span>
                <span>
                  {new Date(p.started_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </span>
                <span className="track">
                  <span className="bar" style={{ width: `${total > 0 ? Math.round((t / total) * 100) : 0}%` }} />
                </span>
                <span className="num">{abbreviate(t)}</span>
                <span className="num">{p.events.filter((e) => e.kind === "tool_call").length} tools</span>
              </div>
            );
          })}
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          Prompt text never leaves the laptop. sesh keeps its length and what it set in motion.
        </p>
      </section>

      {data.prompts.map((p, i) => (
        <section className="section" key={p.id}>
          <p className="eyebrow">Prompt {i + 1}</p>
          <Events sessionId={id} events={p.events} />
        </section>
      ))}
      {data.unattributed_events.length > 0 && (
        <section className="section">
          <p className="eyebrow">Events outside any prompt</p>
          <Events sessionId={id} events={data.unattributed_events} />
        </section>
      )}
    </>
  );
}
