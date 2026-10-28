import { useEffect, useState } from "react";
import { MultiLineChart, type Series } from "./chart.js";
import { num } from "./fmt.js";
import { message } from "./layout.js";
import { api } from "./session.js";

interface Counts {
  tool_calls: number;
  prompts: number;
  active_sessions: number;
  /** Null when there were no prompts. */
  tool_calls_per_prompt: number | null;
}
interface Activity {
  days: (Counts & { day: string })[];
  /** Average per day for each weekday, Mon..Sun. */
  by_dow: (Counts & { dow: string })[];
  today: Counts;
  org_sessions: number;
}

const RANGES = [7, 14, 28];
const DEFAULT_RANGE = 14;
/** The series, in the order of the chips and the chart. `id` is what `?metrics=` calls it. */
const METRICS: { id: string; key: keyof Counts; label: string; className: string; axis: "left" | "right" }[] = [
  { id: "prompts", key: "prompts", label: "Prompts", className: "s-prompts", axis: "left" },
  { id: "tools", key: "tool_calls", label: "Tool calls", className: "s-tools", axis: "left" },
  { id: "sessions", key: "active_sessions", label: "Active sessions", className: "s-sessions", axis: "left" },
  { id: "ratio", key: "tool_calls_per_prompt", label: "Tool calls per prompt", className: "s-ratio", axis: "right" },
];
const DEFAULT_METRICS = ["prompts", "tools", "sessions"];

/** `by=weekday` in the URL shows the weekday averages; anything else the daily series. */
const byWeekdayFromUrl = () => new URLSearchParams(location.search).get("by") === "weekday";

/** The range in the URL (`?days=7|14|28`), else the default. */
function rangeFromUrl(): number {
  const days = Number(new URLSearchParams(location.search).get("days"));
  return RANGES.includes(days) ? days : DEFAULT_RANGE;
}

/** The metrics on in the URL (`?metrics=prompts,tools`), in chart order; the default when none is valid. */
function metricsFromUrl(): string[] {
  const asked = (new URLSearchParams(location.search).get("metrics") ?? "").split(",");
  const on = METRICS.map((m) => m.id).filter((id) => asked.includes(id));
  return on.length > 0 ? on : DEFAULT_METRICS;
}

/** Keeps the URL in step with the page: only what differs from the defaults is written. */
function writeUrl(days: number, metrics: string[], weekday: boolean) {
  const parts: string[] = [];
  if (weekday) parts.push("by=weekday");
  if (days !== DEFAULT_RANGE) parts.push(`days=${days}`);
  if (metrics.join() !== DEFAULT_METRICS.join()) parts.push(`metrics=${metrics.join(",")}`);
  history.replaceState(null, "", parts.length ? `?${parts.join("&")}` : location.pathname);
}

/** A count, or a dash when there is none to show (no prompts). */
const perPrompt = (n: number | null) => (n === null ? "–" : num(n));

/** Motion over time: tool calls, prompts and active sessions for each UTC day. It names no one. */
export function Insights() {
  const [days, setDays] = useState(rangeFromUrl);
  const [on, setOn] = useState(metricsFromUrl);
  const [weekday, setWeekday] = useState(byWeekdayFromUrl);
  const [data, setData] = useState<Activity>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setError(undefined);
    api<Activity>(`/insights/activity?days=${days}`).then(setData, (e) => setError(message(e)));
  }, [days]);

  function pick(n: number) {
    writeUrl(n, on, weekday);
    setDays(n);
  }

  function pickView(next: boolean) {
    writeUrl(days, on, next);
    setWeekday(next);
  }

  function toggle(id: string) {
    const next = on.includes(id)
      ? on.filter((m) => m !== id)
      : METRICS.map((m) => m.id).filter((m) => m === id || on.includes(m));
    if (next.length === 0) return; // at least one stays on
    writeUrl(days, next, weekday);
    setOn(next);
  }

  const series: Series[] = data
    ? METRICS.filter((m) => on.includes(m.id)).map((m) => ({
        key: m.id,
        label: m.label,
        axis: m.axis,
        className: m.className,
        values: (weekday ? data.by_dow : data.days).map((d) => d[m.key]),
      }))
    : [];

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
                  <div className="label">{m.id === "sessions" ? "Sessions active" : m.label}</div>
                  <div className="num">{perPrompt(data.today[m.key])}</div>
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
            <div className="range" role="group" aria-label="View">
              {[false, true].map((w) => (
                <button
                  key={String(w)}
                  type="button"
                  className="range-button"
                  aria-pressed={w === weekday}
                  onClick={() => pickView(w)}
                >
                  {w ? "By weekday" : "By day"}
                </button>
              ))}
            </div>
            <div className="chips" role="group" aria-label="Metrics">
              {METRICS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`chip ${m.className}`}
                  aria-pressed={on.includes(m.id)}
                  aria-disabled={on.length === 1 && on.includes(m.id)}
                  onClick={() => toggle(m.id)}
                >
                  <svg className="chip-swatch" width="28" height="8" aria-hidden="true">
                    <line className="chart-line" x1="1" x2="27" y1="4" y2="4" />
                  </svg>
                  {m.label}
                </button>
              ))}
            </div>
            <div className="chart-block">
              {weekday ? (
                <MultiLineChart
                  title="Average per weekday"
                  days={data.by_dow.map((d) => d.dow)}
                  names={data.by_dow.map((d) => d.dow)}
                  series={series}
                />
              ) : (
                <MultiLineChart title="Activity" days={data.days.map((d) => d.day)} series={series} />
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
