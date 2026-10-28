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
export function niceScale(max: number): { top: number; step: number } {
  const rough = Math.max(1, max) / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(
    1,
    [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough)!,
  );
  return { top: step * Math.ceil(Math.max(1, max) / step), step };
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
  const label = (p: Point) => `${dayLabel(p.day)}: ${num(p.value)} ${title.toLowerCase()}`;
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
            const showTick = (n - 1 - i) % every === 0;
            const first = i === 0 || d.getUTCDate() === 1;
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
              {num(tip.value)} {title.toLowerCase()}
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
