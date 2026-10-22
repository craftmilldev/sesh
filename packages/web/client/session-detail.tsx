import { useEffect, useState } from "react";
import { api, ApiError, getToken } from "./session.js";

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
  raw: unknown;
}
interface Prompt {
  id: string;
  prompt_length: number | null;
  started_at: string;
  events: Event[];
}
interface Detail {
  session: { user_name: string; started_at: string; prompts: number; tool_calls: number };
  prompts: Prompt[];
  unattributed_events: Event[];
}

const dash = (v: string | number | boolean | null) => (v == null ? "-" : String(v));

function Events({ events }: { events: Event[] }) {
  if (!events.length) return <p>No events.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Kind</th>
            <th>Model</th>
            <th>Tool</th>
            <th>Success</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache read</th>
            <th>Cache write</th>
            <th>Cost (USD)</th>
            <th>Duration (ms)</th>
            <th>Raw</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.occurred_at).toLocaleTimeString()}</td>
              <td>{e.kind}</td>
              <td>{dash(e.model)}</td>
              <td>{dash(e.tool_name)}</td>
              <td>{dash(e.success)}</td>
              <td>{dash(e.input_tokens)}</td>
              <td>{dash(e.output_tokens)}</td>
              <td>{dash(e.cache_read_tokens)}</td>
              <td>{dash(e.cache_write_tokens)}</td>
              <td>{dash(e.cost_usd)}</td>
              <td>{dash(e.duration_ms)}</td>
              <td>
                <details>
                  <summary>JSON</summary>
                  <pre>{JSON.stringify(e.raw, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const [data, setData] = useState<Detail>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!getToken()) return location.replace("/login");
    api<Detail>(`/sessions/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }, [id]);

  if (error)
    return (
      <>
        <p className="error">{error}</p>
        <p>
          <a href="/app">Back to sessions</a>
        </p>
      </>
    );
  if (!data) return null;

  const { session } = data;
  return (
    <>
      <p>
        <a href="/app">Back to sessions</a>
      </p>
      <h2>Session by {session.user_name}</h2>
      <p>
        Started {new Date(session.started_at).toLocaleString()}. {session.prompts} prompts, {session.tool_calls} tool
        calls.
      </p>
      {data.prompts.map((p, i) => (
        <section key={p.id}>
          <h3>
            Prompt {i + 1} <small>{new Date(p.started_at).toLocaleTimeString()}</small>
          </h3>
          <Events events={p.events} />
        </section>
      ))}
      {data.unattributed_events.length > 0 && (
        <section>
          <h3>Events outside any prompt</h3>
          <Events events={data.unattributed_events} />
        </section>
      )}
    </>
  );
}
