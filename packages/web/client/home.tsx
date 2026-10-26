import { useEffect, useState } from "react";
import { abbreviate, clock, localMidnight, num, share } from "./fmt.js";
import { message } from "./layout.js";
import { api } from "./session.js";

interface Today {
  sessions: number;
  org_sessions: number;
  tokens: number;
  cache_read_tokens: number;
  prompts: number;
  tool_calls: number;
  top: {
    id: string;
    started_at: string;
    tokens: number;
    cache_read_tokens: number;
    prompts: number;
    tool_calls: number;
  }[];
}
interface Pool {
  members: number;
  five_hour_used: number;
  seven_day_used: number;
  five_hour_reporting: number;
  seven_day_reporting: number;
  seven_day_expected: number;
  seven_day_pace: number | null;
}

/** A session above this share of the day is the page's one highlight. */
const HOT_SHARE = 0.4;
/** Plan usage (percent) from which the pool figure is shown as a warning. */
const POOL_HOT = 80;

function Figure({ label, value, note, hot }: { label: string; value: string; note: string; hot?: boolean }) {
  return (
    <div className="figure">
      <div className="label">{label}</div>
      <div className={hot ? "num hot" : "num"}>{value}</div>
      <p className="note">{note}</p>
    </div>
  );
}

/** The main page: what the team did today, as a team. It names no one. */
export function Home({ orgName }: { orgName: string }) {
  const [today, setToday] = useState<Today>();
  const [pool, setPool] = useState<Pool>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<Today>(`/today?since=${encodeURIComponent(localMidnight().toISOString())}`).then(setToday, (e) =>
      setError(message(e)),
    );
    api<Pool>("/limits").then(setPool, () => setPool(undefined));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!today) return null;

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const cacheMillions = (today.cache_read_tokens / 1e6).toFixed(1);
  return (
    <>
      <section className="section hero">
        <p className="eyebrow">{date.toUpperCase()}</p>
        <h1>
          {num(today.sessions)} {today.sessions === 1 ? "session" : "sessions"} in {orgName} today
        </h1>
      </section>

      {today.org_sessions === 0 ? (
        <section className="section">
          <p className="prose">
            Sessions appear here once Claude Code sends its first events. <a href="/app/tokens">Tokens</a> has the token
            and the settings to connect it.
          </p>
        </section>
      ) : (
        <>
          <section className="section">
            <p className="eyebrow">Today in figures</p>
            <div className="figures">
              <Figure label="Tokens" value={abbreviate(today.tokens)} note={`${cacheMillions}M read from cache`} />
              <Figure
                label="Cache hit"
                value={share(today.cache_read_tokens, today.tokens)}
                note="of all tokens today"
              />
              <Figure label="Prompts" value={num(today.prompts)} note={`across ${num(today.sessions)} sessions`} />
              <Figure label="Tool calls" value={num(today.tool_calls)} note="run by Claude Code" />
            </div>
          </section>

          {pool && (
            <section className="section pool">
              <div>
                <p className="eyebrow">Team plan usage</p>
                <h2>How much of the plan the team has used</h2>
                <p className="muted">
                  Every member&apos;s plan window goes into one pool, each an equal share. A member who hasn&apos;t
                  reported counts as 0% used. Higher is closer to the limit. Pace compares the 7 day pool with using it
                  all by each reset at 20% a weekday and nothing on Saturday and Sunday (UTC): 100% is using the plan as
                  fast as time passes.
                </p>
              </div>
              <div className="figures big">
                <Figure
                  label="5 hr used"
                  value={`${pool.five_hour_used}%`}
                  hot={pool.five_hour_used >= POOL_HOT}
                  note={`of the team pool · ${pool.five_hour_reporting} of ${pool.members} members reporting`}
                />
                <Figure
                  label="7 day used"
                  value={`${pool.seven_day_used}%`}
                  hot={pool.seven_day_used >= POOL_HOT}
                  note={`of the team pool · ${pool.seven_day_reporting} of ${pool.members} members reporting`}
                />
                <Figure
                  label="7 day pace"
                  value={pool.seven_day_pace == null ? "—" : `${pool.seven_day_pace}%`}
                  note={`of an even weekday pace · ${pool.seven_day_expected}% of the pool expected by now`}
                />
              </div>
            </section>
          )}

          <section className="section">
            <p className="eyebrow">The ledger · heaviest first</p>
            <div className="head">
              <h2>Where the tokens went</h2>
              <p className="muted">
                Top {today.top.length} of {num(today.sessions)} · bar is share of the day
              </p>
            </div>
            {today.top.length === 0 ? (
              <p className="prose">No sessions yet today.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th style={{ width: "50%" }}>Tokens</th>
                      <th className="num">Cache hit</th>
                      <th className="num">Prompts</th>
                      <th className="num">Tools</th>
                    </tr>
                  </thead>
                  <tbody>
                    {today.top.map((s) => {
                      const part = today.tokens > 0 ? s.tokens / today.tokens : 0;
                      return (
                        <tr key={s.id}>
                          <td>
                            <a href={`/app/sessions/${s.id}`}>{clock(new Date(s.started_at))}</a>
                          </td>
                          <td className={part > HOT_SHARE ? "hot" : undefined}>
                            <div className="share">
                              <span className="n">{abbreviate(s.tokens)}</span>
                              <span className="track">
                                <span className="bar" style={{ width: `${Math.round(part * 100)}%` }} />
                              </span>
                            </div>
                          </td>
                          <td className="num">{share(s.cache_read_tokens, s.tokens)}</td>
                          <td className="num">{num(s.prompts)}</td>
                          <td className="num">{num(s.tool_calls)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="pager">
              <a href="/app/sessions">All {num(today.org_sessions)} sessions</a>
            </p>
          </section>
        </>
      )}
    </>
  );
}
