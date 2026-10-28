import { beforeEach, describe, expect, it, vi } from "vitest";

const captureImmediate = vi.fn(async () => {});
vi.mock("posthog-node", () => ({
  PostHog: class {
    captureImmediate = captureImmediate;
  },
}));

const { createMetrics, noopMetrics } = await import("../src/metrics.js");

describe("createMetrics", () => {
  beforeEach(() => captureImmediate.mockClear());

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
});
