// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../client/home.js";
import { Chrome, Page } from "../client/layout.js";
import { Settings } from "../client/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const orgs = [
  { id: "o1", name: "alpha", role: "owner" },
  { id: "o2", name: "beta", role: "member" },
];

/** A fake API where /me reports whichever org the last switch chose. */
function fakeApi(opts: { sessions?: number } = {}) {
  let active = orgs[0]!;
  const sessions = opts.sessions ?? 3;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, "").split("?")[0];
    if (path === "/orgs/switch")
      active = orgs.find((o) => o.id === (JSON.parse(init?.body as string) as { org: string }).org)!;
    const body =
      path === "/me"
        ? { user: { name: "Ada" }, org: active, orgs, ingest_endpoint: "https://sesh.test" }
        : path === "/today"
          ? {
              sessions,
              org_sessions: sessions,
              tokens: 51_700_000,
              cache_read_tokens: 50_500_000,
              prompts: 40,
              tool_calls: 200,
              top: sessions
                ? [
                    {
                      id: "s1",
                      started_at: "2026-10-22T14:00:00.000Z",
                      tokens: 30_000_000,
                      cache_read_tokens: 29_000_000,
                      prompts: 9,
                      tool_calls: 50,
                    },
                  ]
                : [],
            }
          : path === "/limits"
            ? {
                members: 4,
                five_hour_used: 19,
                seven_day_used: 90,
                five_hour_reporting: 2,
                seven_day_reporting: 3,
              }
            : path === "/members"
              ? { members: [{ name: "Ada", role: "owner" }] }
              : path === "/tokens"
                ? { tokens: [{ id: `t-${active.id}`, name: `token of ${active.name}` }] }
                : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("signed-in pages", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem("sesh_session", "tok");
    consoleError = vi.fn();
    vi.stubGlobal("console", { ...console, error: consoleError });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const text = () => container.textContent ?? "";
  const sessionsPage = () => <Page current="sessions">{({ me }) => <Home orgName={me.org.name} />}</Page>;
  const settingsPage = () => <Page current="settings">{(ctx) => <Settings {...ctx} />}</Page>;

  it("draws the same masthead and footer, with the current tab marked and no role or org switcher", async () => {
    vi.stubGlobal("fetch", fakeApi());
    await act(async () => root.render(sessionsPage()));
    expect(container.querySelector(".wordmark")!.getAttribute("href")).toBe("/app");
    expect(container.querySelector(".strapline")!.textContent).toBe("Session ledger · a Craftmill works");
    const tabs = [...container.querySelectorAll(".tab")];
    expect(tabs.map((a) => a.getAttribute("href"))).toEqual(["/app", "/app/settings"]);
    expect(tabs.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null]);
    expect(container.querySelector(".who")!.textContent).toBe("alpha · Ada");
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector(".nav-button")!.textContent).toBe("Sign out");
    expect(container.querySelector(".footer")!.textContent).toBe("Sesh · Craftmill · Plumbline LLC, Maine");
  });

  it("signs out from the header on every signed-in page, and only there", async () => {
    vi.stubGlobal("fetch", fakeApi());
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    await act(async () => root.render(settingsPage()));
    const buttons = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Sign out");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest(".nav")).not.toBeNull();
    await act(async () => buttons[0]!.click());
    expect(localStorage.getItem("sesh_session")).toBeNull();
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("draws the same chrome signed out, with Sign in in the nav and no tabs", async () => {
    localStorage.clear();
    await act(async () => root.render(<Chrome current="login">hello</Chrome>));
    expect(container.querySelector(".wordmark")!.getAttribute("href")).toBe("/");
    const tabs = [...container.querySelectorAll(".tab")];
    expect(tabs.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Sign in", "/login"]]);
    expect(container.querySelector(".nav-button")).toBeNull();
    expect(container.querySelector("main")!.textContent).toBe("hello");
    expect(container.querySelector(".footer")).not.toBeNull();
  });

  it("shows the team's day: figures, the pool and the heaviest sessions, with no names", async () => {
    vi.stubGlobal("fetch", fakeApi());
    await act(async () => root.render(sessionsPage()));
    expect(container.querySelector("h1")!.textContent).toBe("3 sessions in alpha today");
    expect(text()).toContain("51.7M");
    expect(text()).toContain("50.5M read from cache");
    expect(text()).toContain("97.7%");
    expect(text()).toContain("19%");
    expect(text()).toContain("5 hr used");
    expect(text()).not.toContain("left");
    expect(text()).toContain("of the team pool · 2 of 4 members reporting");
    expect(text()).toContain("90%");
    expect(container.querySelectorAll(".figure .num.hot")).toHaveLength(1); // 90% used is a warning, 19% is not
    expect(text()).toContain("Top 1 of 3");
    expect(container.querySelector("tbody a")!.getAttribute("href")).toBe("/app/sessions/s1");
    expect(container.querySelector("td.hot")).not.toBeNull(); // 30M of 51.7M is over 40% of the day
    expect(container.querySelector('a[href="/app/sessions"]')!.textContent).toBe("All 3 sessions");
    expect(text()).not.toContain("Ada ·".replace("·", "Who"));
  });

  it("says where to start when the org has no sessions at all", async () => {
    vi.stubGlobal("fetch", fakeApi({ sessions: 0 }));
    await act(async () => root.render(sessionsPage()));
    expect(text()).toContain("Sessions appear here once Claude Code sends its first events.");
    expect(container.querySelector("table")).toBeNull();
  });

  it("puts members, the org forms and tokens on the settings page, once per org after each switch", async () => {
    vi.stubGlobal("fetch", fakeApi());
    await act(async () => root.render(settingsPage()));
    const headings = () => [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(container.querySelector("h1")!.textContent).toBe("Org and tokens");
    expect(headings()).toEqual(["alpha", "Ingest tokens for alpha"]);
    expect(text()).toContain("Ada");
    expect(text()).toContain("token of alpha");

    const switchTo = async (id: string) => {
      const select = container.querySelector("select")!;
      await act(async () => {
        select.value = id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Switch")!;
      await act(async () => button.click());
    };
    await switchTo("o2");
    expect(headings()).toEqual(["beta", "Ingest tokens for beta"]);
    expect(text()).toContain("token of beta");
    expect(text()).not.toContain("token of alpha");
    expect(container.querySelectorAll(".tab[aria-current]")).toHaveLength(1);
    expect(container.textContent).not.toContain("Send invite"); // beta: a member, not an owner
    expect(consoleError).not.toHaveBeenCalled(); // no duplicate-key warnings
  });
});
