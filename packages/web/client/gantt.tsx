import { useState } from "react";
import { abbreviate, duration, num } from "./fmt.js";

export interface GanttSession {
  id: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  tokens: number;
  prompts: number;
  tool_calls: number;
  /** Ended within the last few minutes. */
  ongoing: boolean;
}

export interface GanttData {
  /** The range, [from, to): UTC midnights. */
  from: string;
  to: string;
  total: number;
  /** Longest first. */
  sessions: GanttSession[];
}

const W = 600;
const LEFT = 56;
const PLOT_W = W - LEFT - 4;
const ROW = 10;
const BAR = 6;
const AXIS_H = 46;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The first eight characters of a session id. */
export const shortId = (id: string) => id.slice(0, 8);

/** "2026-10-27 14:03 UTC". */
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Sessions as bars over the UTC days of the range, one row each, longest on top. Rows are labeled by short id only. */
export function GanttChart({ data, title }: { data: GanttData; title: string }) {
  const [active, setActive] = useState<number>();
  const from = Date.parse(data.from);
  const to = Date.parse(data.to);
  const dayCount = Math.round((to - from) / DAY_MS);
  const x = (ms: number) => LEFT + ((ms - from) / (to - from)) * PLOT_W;
  const height = Math.max(1, data.sessions.length) * ROW;
  const every = dayCount > 14 ? 2 : 1;
  const tip = active === undefined ? undefined : data.sessions[active]!;

  return (
    <figure className="chart-figure">
      <figcaption className="chart-caption">
        <span className="chart-title">{title}</span>
        <span className="chart-today">
          {data.total > data.sessions.length
            ? `showing ${data.sessions.length} of ${num(data.total)}`
            : num(data.total)}
        </span>
      </figcaption>
      {data.total === 0 ? (
        <p className="prose">No sessions in this range.</p>
      ) : (
        <div className="gantt-scroll">
          <svg
            className="chart gantt-axis"
            viewBox={`0 0 ${W} ${AXIS_H}`}
            role="img"
            aria-label={`${title}: days of the range`}
          >
            <rect className="gantt-axis-bg" x="0" y="0" width={W} height={AXIS_H} />
            {Array.from({ length: dayCount }, (_, i) => {
              const day = new Date(from + i * DAY_MS);
              const isToday = i === dayCount - 1;
              const first = i === 0 || day.getUTCDate() === 1;
              if (!first && (dayCount - 1 - i) % every !== 0) return null;
              const cx = x(from + i * DAY_MS + DAY_MS / 2);
              return (
                <text
                  key={i}
                  className={`chart-tick day${isToday ? " today-tick" : ""}`}
                  x={cx}
                  y={14}
                  textAnchor="middle"
                  fill={isToday ? "var(--madder-600)" : undefined}
                >
                  <tspan x={cx}>{WEEKDAYS[day.getUTCDay()]![0]}</tspan>
                  <tspan x={cx} dy={13}>
                    {day.getUTCDate()}
                  </tspan>
                  {(first || isToday) && (
                    <tspan x={cx} dy={13}>
                      {isToday && !first ? "today" : MONTHS[day.getUTCMonth()]}
                    </tspan>
                  )}
                </text>
              );
            })}
            <line className="chart-axis" x1={LEFT} x2={W} y1={AXIS_H - 1} y2={AXIS_H - 1} />
          </svg>
          <div className="gantt-body">
            <svg
              className="chart gantt-rows"
              viewBox={`0 0 ${W} ${height}`}
              role="group"
              aria-label={`${title}, longest first`}
              onMouseLeave={() => setActive(undefined)}
            >
              <rect className="gantt-today" x={x(to - DAY_MS)} y={0} width={x(to) - x(to - DAY_MS)} height={height} />
              {Array.from({ length: dayCount + 1 }, (_, i) => (
                <line
                  key={i}
                  className="chart-grid"
                  x1={x(from + i * DAY_MS)}
                  x2={x(from + i * DAY_MS)}
                  y1={0}
                  y2={height}
                />
              ))}
              {data.sessions.map((s, i) => {
                const start = Date.parse(s.started_at);
                const end = Date.parse(s.ended_at);
                const x1 = x(Math.max(start, from));
                const x2 = Math.max(x1 + 2, x(Math.min(end, to)));
                const y = i * ROW + (ROW - BAR) / 2;
                const openLeft = start < from;
                const openRight = s.ongoing;
                return (
                  <a
                    key={s.id}
                    href={`/app/sessions/${s.id}`}
                    className={`chart-point gantt-link${active === i ? " active" : ""}`}
                    role="img"
                    aria-label={`${shortId(s.id)}: ${utc(s.started_at)} to ${utc(s.ended_at)}, ${duration(s.duration_seconds)}`}
                    data-session={s.id}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(undefined)}
                  >
                    <rect className="chart-hit" x={0} y={i * ROW} width={W} height={ROW} />
                    <text className="chart-tick" x={LEFT - 6} y={i * ROW + ROW - 2} textAnchor="end" fontSize="8">
                      {shortId(s.id)}
                    </text>
                    <rect className="gantt-bar" x={x1} y={y} width={x2 - x1} height={BAR} />
                    {openLeft && (
                      <line className="gantt-edge open-left" x1={x1 + 1.5} x2={x1 + 1.5} y1={y} y2={y + BAR} />
                    )}
                    {openRight && (
                      <line className="gantt-edge open-right" x1={x2 - 1.5} x2={x2 - 1.5} y1={y} y2={y + BAR} />
                    )}
                  </a>
                );
              })}
            </svg>
            {tip && (
              <div
                className="chart-tip"
                role="status"
                style={{
                  left: `${(x(Math.max(Date.parse(tip.started_at), from)) / W) * 100}%`,
                  top: `${active! * ROW}px`,
                }}
              >
                <span className="chart-tip-day">{shortId(tip.id)}</span>
                <span className="chart-tip-value">
                  {utc(tip.started_at)} to {utc(tip.ended_at)}
                </span>
                <span className="chart-tip-value">{duration(tip.duration_seconds)}</span>
                <span className="chart-tip-value">
                  {abbreviate(tip.tokens)} tokens · {num(tip.prompts)} prompts · {num(tip.tool_calls)} tool calls
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </figure>
  );
}
