import { PostHog } from "posthog-node";

/** Product metrics. Sends nothing unless POSTHOG_API_KEY is set. */
export interface Metrics {
  /** Records one event for `distinctId`. Never throws: metrics must not break a request. */
  capture(event: string, distinctId: string, properties?: Record<string, unknown>): Promise<void>;
}

export const noopMetrics: Metrics = { capture: async () => {} };

/** Set on every event so reports can filter on `product = sesh` (`app` says which part of Sesh sent it). */
export const IDENTITY = { product: "sesh", app: "sesh-web" } as const;

/** Craftmill's shared PostHog proxy (CRA-224); POSTHOG_HOST overrides it (a full URL). */
export const DEFAULT_HOST = "https://a.craftmill.dev/api/ingest";

/** Who an event is about when nobody is logged in. */
export const ANONYMOUS = "anonymous";

export function createMetrics(env: NodeJS.ProcessEnv = process.env): Metrics {
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return noopMetrics;
  const client = new PostHog(apiKey, { host: env.POSTHOG_HOST || DEFAULT_HOST });
  return {
    // Sent right away, not batched: a serverless function can be frozen before a batch goes out.
    async capture(event, distinctId, properties) {
      try {
        await client.captureImmediate({ distinctId, event, properties: { ...properties, ...IDENTITY } });
      } catch (err) {
        console.error("metrics:", err);
      }
    },
  };
}
