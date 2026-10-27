/** A UTC day: [start, end), the one "day" the app means for everyone, whatever their timezone. */
export interface UtcDay {
  start: Date;
  end: Date;
}

/** The UTC day `date` falls in. */
export function utcDay(date: Date): UtcDay {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** The UTC day named "YYYY-MM-DD", or undefined when it isn't a real date. */
export function parseUtcDay(text: string): UtcDay | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? undefined : utcDay(date);
}
