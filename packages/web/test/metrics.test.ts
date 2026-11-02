import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn(async () => {});
const createAnalytics = vi.fn<(config: Record<string, unknown>) => { capture: typeof capture }>(() => ({ capture }));
vi.mock("@craftmilldev/analytics/server", () => ({ createAnalytics }));

const { createMetrics, noopMetrics, DEFAULT_HOST } = await import("../src/metrics.js");

describe("createMetrics", () => {
  beforeEach(() => {
    capture.mockClear();
    createAnalytics.mockClear();
  });

  it("is a no-op without POSTHOG_API_KEY", () => {
    expect(createMetrics({})).toBe(noopMetrics);
    expect(createAnalytics).not.toHaveBeenCalled();
  });

  it("is the shared package, set up as Sesh's web server and sent through the shared proxy", async () => {
    const metrics = createMetrics({ POSTHOG_API_KEY: "phc_test" });
    expect(createAnalytics).toHaveBeenCalledWith({
      product: "sesh",
      app: "sesh-web",
      apiKey: "phc_test",
      host: DEFAULT_HOST,
    });
    await metrics.capture("login_requested", "u1", { reason: "x" });
    expect(capture).toHaveBeenCalledWith("login_requested", "u1", { reason: "x" });
  });

  it("sends to POSTHOG_HOST when set", () => {
    createMetrics({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" });
    expect(createAnalytics).toHaveBeenCalledWith(expect.objectContaining({ host: "https://eu.i.posthog.com" }));
  });
});
