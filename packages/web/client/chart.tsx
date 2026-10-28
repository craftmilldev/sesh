import { useState } from "react";
import { abbreviate, num } from "./fmt.js";

export interface Point {
  /** A UTC day, `YYYY-MM-DD`. */
  day: string;
  value: number;
}

const W = 600;
const H = 150;
const LEFT = 36;
const TOP = 12;
const BOTTOM = 40;
const PLOT_W = W - LEFT - 4;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const parse = (day: string) => new Date(`${day}T00:00:00Z`);

/** "Tue Oct 27". */
export function dayLabel(day: string): string {
  const d = parse(day);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** A round top for the y axis and the step between its gridlines: 0..top in about four steps. */
export function niceScale(max: number, whole = true): { top: number; step: number } {
  const floor = whole ? 1 : 0.1;
  const rough = Math.max(floor, max) / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(
    floor,
    [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough)!,
  );
  // Round away float noise (0.1 * 3 = 0.30000000000000004).
  const top = Math.round(step * Math.ceil(Math.max(floor, max) / step) * 1e6) / 1e6;
  return { top, step };
}

interface Props {
  /** What the chart counts ("Tool calls"): the tooltip and each bar's accessible label name it. */
  title: string;
  /** Oldest first; the last point is today. */
  values: Point[];
}

/** The frame both variants share: title, today's number, y axis with gridlines, day ticks, tooltip. */
function Chart({ title, values, kind }: Props & { kind: "bar" | "line" }) {
  const [active, setActive] = useState<number>();
  const { top, step } = niceScale(Math.max(...values.map((v) => v.value)));
  const n = values.length;
  const slot = PLOT_W / n;
  const x = (i: number) => LEFT + i * slot + slot / 2;
  const y = (v: number) => TOP + (1 - v / top) * H;
  const gridlines = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const todayValue = values[n - 1]!.value;
  // Thin the ticks to stay legible: every other day at 28, counting back from today.
  const every = n > 14 ? 2 : 1;
  const label = (p: Point) => `${dayLabel(p.day)}: ${title}: ${num(p.value)}`;
  const tip = active === undefined ? undefined : values[active]!;

  return (
    <figure className="chart-figure">
      <figcaption className="chart-caption">
        <span className="chart-title">{title}</span>
        <span className="chart-today">
          {num(todayValue)} <span className="chart-today-label">today</span>
        </span>
      </figcaption>
      <div className="chart-wrap">
        <svg
          className={`chart chart-${kind}`}
          viewBox={`0 0 ${W} ${TOP + H + BOTTOM}`}
          role="group"
          aria-label={`${title} per day`}
          onMouseLeave={() => setActive(undefined)}
        >
          {gridlines.map((g) => (
            <g key={g}>
              <line className={g === 0 ? "chart-axis" : "chart-grid"} x1={LEFT} x2={W} y1={y(g)} y2={y(g)} />
              <text className="chart-tick" x={LEFT - 6} y={y(g) + 4} textAnchor="end">
                {abbreviate(g)}
              </text>
            </g>
          ))}
          {kind === "line" && (
            <polyline
              className="chart-line"
              fill="none"
              points={values.map((v, i) => `${x(i)},${y(v.value)}`).join(" ")}
            />
          )}
          {values.map((v, i) => {
            const isToday = i === n - 1;
            const d = parse(v.day);
            const first = i === 0 || d.getUTCDate() === 1;
            const showTick = first || (n - 1 - i) % every === 0;
            return (
              <g
                key={v.day}
                className={`chart-point${active === i ? " active" : ""}${isToday ? " today" : ""}`}
                tabIndex={0}
                role="img"
                aria-label={label(v)}
                data-day={v.day}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(undefined)}
              >
                <rect className="chart-hit" x={x(i) - slot / 2} y={TOP} width={slot} height={H} />
                {kind === "bar" ? (
                  <rect
                    className="chart-bar"
                    x={x(i) - slot / 2 + 2}
                    y={y(v.value)}
                    width={Math.max(1, slot - 4)}
                    height={TOP + H - y(v.value)}
                  />
                ) : (
                  <circle className="chart-dot" cx={x(i)} cy={y(v.value)} r={isToday || active === i ? 4 : 2.5} />
                )}
                {isToday && (
                  <text className="chart-value" x={x(i)} y={y(v.value) - 5} textAnchor="end">
                    {num(v.value)}
                  </text>
                )}
                {showTick && (
                  <text className="chart-tick day" x={x(i)} y={TOP + H + 14} textAnchor="middle">
                    <tspan x={x(i)}>{WEEKDAYS[d.getUTCDay()]![0]}</tspan>
                    <tspan x={x(i)} dy={13}>
                      {d.getUTCDate()}
                    </tspan>
                    {(first || isToday) && (
                      <tspan x={x(i)} dy={13}>
                        {isToday && !first ? "today" : MONTHS[d.getUTCMonth()]}
                      </tspan>
                    )}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (
          <div
            className="chart-tip"
            role="status"
            style={{ left: `${(x(active!) / W) * 100}%`, top: `${((y(tip.value) - 4) / (TOP + H + BOTTOM)) * 100}%` }}
          >
            <span className="chart-tip-day">{dayLabel(tip.day)}</span>
            <span className="chart-tip-value">
              {title}: {num(tip.value)}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}

/** One metric as a bar per UTC day. */
export const BarChart = (props: Props) => <Chart {...props} kind="bar" />;

/** The same chart as a line, for pace over time (unused until the plan charts). */
export const LineChart = (props: Props) => <Chart {...props} kind="line" />;

export interface Series {
  key: string;
  /** Names the series in the tooltip and each day's accessible label ("Tool calls"). */
  label: string;
  /** Per day, aligned with `days`; null is a gap in the line. */
  values: (number | null)[];
  /** `left` for counts, `right` for a ratio with a scale of its own. */
  axis: "left" | "right";
  /** CSS class that sets the line's colour and dash pattern. */
  className: string;
}

/** Up to two decimals, no trailing zeros: 2.5, 1, 0.33. */
const decimal = (n: number) => String(Math.round(n * 100) / 100);

const RIGHT = 40;

/** Several series as lines over the same UTC days; the `right` series share a second, labeled y axis. */
export function MultiLineChart({ days, series, title }: { days: string[]; series: Series[]; title: string }) {
  const [active, setActive] = useState<number>();
  const left = series.filter((s) => s.axis === "left");
  const right = series.filter((s) => s.axis === "right");
  const maxOf = (list: Series[]) =>
    Math.max(0, ...list.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const leftScale = niceScale(maxOf(left));
  const rightScale = niceScale(maxOf(right), false);
  // The gridlines follow the left scale; with only right series on they follow the right one.
  const primary = left.length > 0 ? leftScale : rightScale;
  const width = W + (right.length > 0 && left.length > 0 ? RIGHT : 0);
  const n = days.length;
  const plotW = width - LEFT - 4 - (right.length > 0 && left.length > 0 ? RIGHT : 0);
  const slot = plotW / n;
  const x = (i: number) => LEFT + i * slot + slot / 2;
  const scaleOf = (s: Series) => (s.axis === "right" && left.length > 0 ? rightScale : primary);
  const y = (s: Series, v: number) => TOP + (1 - v / scaleOf(s).top) * H;
  const gridlines = Array.from({ length: Math.round(primary.top / primary.step) + 1 }, (_, i) => i * primary.step);
  const rightTicks = Array.from(
    { length: Math.round(rightScale.top / rightScale.step) + 1 },
    (_, i) => i * rightScale.step,
  );
  const every = n > 14 ? 2 : 1;
  const show = (s: Series, v: number | null) => (v === null ? "–" : s.axis === "right" ? decimal(v) : num(v));
  const label = (i: number) =>
    `${dayLabel(days[i]!)}: ${series.map((s) => `${s.label}: ${show(s, s.values[i]!)}`).join(", ")}`;
  const segmentsOf = (s: Series) => {
    const segments: string[] = [];
    let run: string[] = [];
    s.values.forEach((v, i) => {
      if (v === null) {
        if (run.length) segments.push(run.join(" "));
        run = [];
      } else run.push(`${x(i)},${y(s, v)}`);
    });
    if (run.length) segments.push(run.join(" "));
    return segments;
  };
  const tickFor = (g: number) => (primary === rightScale && left.length === 0 ? decimal(g) : abbreviate(g));

  return (
    <figure className="chart-figure">
      <figcaption className="chart-caption">
        <span className="chart-title">{title}</span>
      </figcaption>
      <div className="chart-wrap">
        <svg
          className="chart chart-multi"
          viewBox={`0 0 ${width} ${TOP + H + BOTTOM}`}
          role="group"
          aria-label={`${title} per day`}
          onMouseLeave={() => setActive(undefined)}
        >
          {gridlines.map((g) => (
            <g key={g}>
              <line
                className={g === 0 ? "chart-axis" : "chart-grid"}
                x1={LEFT}
                x2={LEFT + plotW}
                y1={TOP + (1 - g / primary.top) * H}
                y2={TOP + (1 - g / primary.top) * H}
              />
              <text className="chart-tick" x={LEFT - 6} y={TOP + (1 - g / primary.top) * H + 4} textAnchor="end">
                {tickFor(g)}
              </text>
            </g>
          ))}
          {right.length > 0 && left.length > 0 && (
            <g className="chart-right-axis">
              {rightTicks.map((g) => (
                <text
                  key={g}
                  className="chart-tick"
                  x={LEFT + plotW + 6}
                  y={TOP + (1 - g / rightScale.top) * H + 4}
                  textAnchor="start"
                >
                  {decimal(g)}
                </text>
              ))}
              <text className="chart-axis-title" x={width} y={TOP - 8} textAnchor="end">
                {right.map((s) => s.label).join(", ")}
              </text>
            </g>
          )}
          {active !== undefined && <line className="chart-guide" x1={x(active)} x2={x(active)} y1={TOP} y2={TOP + H} />}
          {series.map((s) => (
            <g key={s.key} className={`chart-series ${s.className}`} data-series={s.key}>
              {segmentsOf(s).map((points) => (
                <polyline key={points} className="chart-line" fill="none" points={points} />
              ))}
              {s.values.map((v, i) =>
                v === null ? null : (
                  <circle key={days[i]} className="chart-dot" cx={x(i)} cy={y(s, v)} r={active === i ? 4 : 2.5} />
                ),
              )}
            </g>
          ))}
          {days.map((day, i) => {
            const isToday = i === n - 1;
            const d = parse(day);
            const first = i === 0 || d.getUTCDate() === 1;
            const showTick = first || (n - 1 - i) % every === 0;
            return (
              <g
                key={day}
                className={`chart-point${active === i ? " active" : ""}${isToday ? " today" : ""}`}
                tabIndex={0}
                role="img"
                aria-label={label(i)}
                data-day={day}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(undefined)}
              >
                <rect className="chart-hit" x={x(i) - slot / 2} y={TOP} width={slot} height={H} />
                {showTick && (
                  <text className="chart-tick day" x={x(i)} y={TOP + H + 14} textAnchor="middle">
                    <tspan x={x(i)}>{WEEKDAYS[d.getUTCDay()]![0]}</tspan>
                    <tspan x={x(i)} dy={13}>
                      {d.getUTCDate()}
                    </tspan>
                    {(first || isToday) && (
                      <tspan x={x(i)} dy={13}>
                        {isToday && !first ? "today" : MONTHS[d.getUTCMonth()]}
                      </tspan>
                    )}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {active !== undefined && (
          <div
            className="chart-tip"
            role="status"
            style={{ left: `${(x(active) / width) * 100}%`, top: `${((TOP - 4) / (TOP + H + BOTTOM)) * 100}%` }}
          >
            <span className="chart-tip-day">{dayLabel(days[active]!)}</span>
            {series.map((s) => (
              <span className={`chart-tip-value ${s.className}`} key={s.key}>
                {s.label}: {show(s, s.values[active]!)}
              </span>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
