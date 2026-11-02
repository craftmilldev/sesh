import { createAnalytics } from "@craftmilldev/analytics/server";

/** Product metrics. Sends nothing unless POSTHOG_API_KEY is set. */
export interface Metrics {
  /** Records one event for `distinctId`. Never throws: metrics must not break a request. */
  capture(event: string, distinctId: string, properties?: Record<string, unknown>): Promise<void>;
}

export const noopMetrics: Metrics = { capture: async () => {} };

/** Set on every event so reports can filter on `product = sesh` (`app` says which part of Sesh sent it). */
export const IDENTITY = { product: "sesh", app: "sesh-web" } as const;

/** Craftmill's shared PostHog proxy; POSTHOG_HOST overrides it (a full URL, e.g. for a self-hosted PostHog). */
export const DEFAULT_HOST = "https://a.craftmill.dev/api/ingest";

/** Who an event is about when nobody is logged in. */
export const ANONYMOUS = "anonymous";

export function createMetrics(env: NodeJS.ProcessEnv = process.env): Metrics {
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return noopMetrics;
  // The package sets product and app on every event, sends right away (a serverless function can be frozen before
  // a batch goes out) and never throws.
  const analytics = createAnalytics({ ...IDENTITY, apiKey, host: env.POSTHOG_HOST || DEFAULT_HOST });
  return { capture: (event, distinctId, properties) => analytics.capture(event, distinctId, properties) };
}
