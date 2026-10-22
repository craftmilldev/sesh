import { useEffect, useState } from "react";
import { abbreviate, num, share } from "./fmt.js";
import { message } from "./layout.js";
import { api } from "./session.js";

interface Row {
  id: string;
  started_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  prompts: number;
  tool_calls: number;
}
interface Listing {
  page: number;
  page_size: number;
  total: number;
  sessions: Row[];
}

/** Every session of the org, newest first, a page at a time. */
export function AllSessions() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Listing>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setError(undefined);
    api<Listing>(`/sessions?page=${page}`).then(setData, (e) => setError(message(e)));
  }, [page]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  return (
    <section className="section">
      <p className="eyebrow">The ledger · newest first</p>
      <div className="head">
        <h2>All sessions</h2>
        <p className="muted">
          <a href="/app">Back to today</a>
        </p>
      </div>
      {data.total === 0 ? (
        <p className="prose">
          Sessions appear here once Claude Code sends its first events. <a href="/app/settings">Org &amp; tokens</a>
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cache hit</th>
                  <th className="num">Prompts</th>
                  <th className="num">Tools</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => {
                  const total = s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens;
                  return (
                    <tr key={s.id}>
                      <td>
                        <a href={`/app/sessions/${s.id}`}>{new Date(s.started_at).toLocaleString()}</a>
                      </td>
                      <td className="num" title={num(total)}>
                        {abbreviate(total)}
                      </td>
                      <td className="num">{share(s.cache_read_tokens, total)}</td>
                      <td className="num">{num(s.prompts)}</td>
                      <td className="num">{num(s.tool_calls)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Newer
            </button>
            <span>
              Page {data.page} of {pages}
            </span>
            <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Older
            </button>
          </div>
        </>
      )}
    </section>
  );
}
