import { useEffect, useState } from "react";
import { api, ApiError } from "./session.js";

interface Session {
  id: string;
  user_name: string;
  started_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  prompts: number;
  tool_calls: number;
}
interface Page {
  page: number;
  page_size: number;
  total: number;
  sessions: Session[];
}

const num = (n: number) => n.toLocaleString("en-US");
const total = (s: Session) => s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens;

export function Sessions({ orgName }: { orgName: string }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setError(undefined);
    api<Page>(`/sessions?page=${page}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }, [page]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  return (
    <>
      <h2>Sessions in {orgName}</h2>
      {data.total === 0 ? (
        <p>
          No sessions yet. To connect Claude Code, create an ingest token below and set the environment variables shown
          there in the shell Claude Code runs in. Sessions appear here once Claude Code has sent its first events.
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Started</th>
                  <th>Tokens</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache read</th>
                  <th>Cache write</th>
                  <th>Prompts</th>
                  <th>Tool calls</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.user_name}</td>
                    <td>{new Date(s.started_at).toLocaleString()}</td>
                    <td>{num(total(s))}</td>
                    <td>{num(s.input_tokens)}</td>
                    <td>{num(s.output_tokens)}</td>
                    <td>{num(s.cache_read_tokens)}</td>
                    <td>{num(s.cache_write_tokens)}</td>
                    <td>{num(s.prompts)}</td>
                    <td>{num(s.tool_calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Newer
            </button>{" "}
            Page {data.page} of {pages}{" "}
            <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Older
            </button>
          </p>
        </>
      )}
    </>
  );
}
