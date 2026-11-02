import { beforeEach, describe, expect, it, vi } from "vitest";

const captureImmediate = vi.fn(async () => {});
const ctor = vi.fn();
vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      ctor(...args);
    }
    captureImmediate = captureImmediate;
  },
}));

const { createMetrics, noopMetrics, DEFAULT_HOST } = await import("../src/metrics.js");

describe("createMetrics", () => {
  beforeEach(() => {
    captureImmediate.mockClear();
    ctor.mockClear();
  });

  it("is a no-op without POSTHOG_API_KEY", () => {
    expect(createMetrics({})).toBe(noopMetrics);
  });

  it("tags every event as Sesh, even if the caller passes its own app", async () => {
    const metrics = createMetrics({ POSTHOG_API_KEY: "phc_test" });
    await metrics.capture("login_requested", "u1", { app: "other", reason: "x" });
    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: "u1",
      event: "login_requested",
      properties: { reason: "x", product: "sesh", app: "sesh-web" },
    });
  });

  it("sends through the shared proxy unless POSTHOG_HOST says otherwise", () => {
    createMetrics({ POSTHOG_API_KEY: "phc_test" });
    expect(ctor).toHaveBeenLastCalledWith("phc_test", { host: DEFAULT_HOST });
    createMetrics({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" });
    expect(ctor).toHaveBeenLastCalledWith("phc_test", { host: "https://eu.i.posthog.com" });
  });
});
