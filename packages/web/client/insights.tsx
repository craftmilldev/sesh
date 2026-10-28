import { useEffect, useState } from "react";
import { BarChart } from "./chart.js";
import { num } from "./fmt.js";
import { message } from "./layout.js";
import { api } from "./session.js";

interface Counts {
  tool_calls: number;
  prompts: number;
  active_sessions: number;
}
interface Activity {
  days: (Counts & { day: string })[];
  today: Counts;
  org_sessions: number;
}

const RANGES = [7, 14, 28];
const DEFAULT_RANGE = 14;
const METRICS: { key: keyof Counts; title: string; label: string }[] = [
  { key: "tool_calls", title: "Tool calls", label: "Tool calls" },
  { key: "prompts", title: "Prompts", label: "Prompts" },
  { key: "active_sessions", title: "Active sessions", label: "Sessions active" },
];

/** The range in the URL (`?days=7|14|28`), else the default. */
function rangeFromUrl(): number {
  const days = Number(new URLSearchParams(location.search).get("days"));
  return RANGES.includes(days) ? days : DEFAULT_RANGE;
}

/** Motion over time: tool calls, prompts and active sessions for each UTC day. It names no one. */
export function Insights() {
  const [days, setDays] = useState(rangeFromUrl);
  const [data, setData] = useState<Activity>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setError(undefined);
    api<Activity>(`/insights/activity?days=${days}`).then(setData, (e) => setError(message(e)));
  }, [days]);

  function pick(n: number) {
    history.replaceState(null, "", `?days=${n}`);
    setDays(n);
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  return (
    <>
      <section className="section hero">
        <p className="eyebrow">INSIGHTS · UTC DAYS</p>
        <h1>Activity per day</h1>
      </section>

      {data.org_sessions === 0 ? (
        <section className="section">
          <p className="prose">
            Sessions appear here once Claude Code sends its first events. <a href="/app/tokens">Tokens</a> has the token
            and the settings to connect it.
          </p>
        </section>
      ) : (
        <>
          <section className="section">
            <p className="eyebrow">Today</p>
            <div className="figures">
              {METRICS.map((m) => (
                <div className="figure" key={m.key}>
                  <div className="label">{m.label}</div>
                  <div className="num">{num(data.today[m.key])}</div>
                </div>
              ))}
            </div>
          </section>
          <section className="section">
            <p className="eyebrow">The last {days} days</p>
            <div className="range" role="group" aria-label="Range">
              {RANGES.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="range-button"
                  aria-pressed={n === days}
                  onClick={() => pick(n)}
                >
                  {n} days
                </button>
              ))}
            </div>
            {METRICS.map((m) => (
              <div className="chart-block" key={m.key}>
                <BarChart title={m.title} values={data.days.map((d) => ({ day: d.day, value: d[m.key] }))} />
              </div>
            ))}
          </section>
        </>
      )}
    </>
  );
}
