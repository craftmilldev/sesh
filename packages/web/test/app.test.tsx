// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../client/home.js";
import { Landing } from "../client/landing.js";
import { Chrome, Page } from "../client/layout.js";
import { Members } from "../client/members.js";
import { page } from "../client/routes.js";
import { Tokens } from "../client/tokens.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const orgs = [
  { id: "o1", name: "alpha", role: "owner", counts_toward_team: true },
  { id: "o2", name: "beta", role: "member", counts_toward_team: true },
];

/** A fake API where /me reports whichever org the last switch chose. */
function fakeApi(opts: { sessions?: number; observer?: boolean } = {}) {
  let active = opts.observer ? { ...orgs[0]!, counts_toward_team: false } : orgs[0]!;
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
              ? {
                  members: [
                    { name: "Ada", role: "owner", counts_toward_team: true, you: true },
                    { name: "Sam", role: "member", counts_toward_team: false, you: false },
                  ],
                }
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
  const membersPage = () => <Page current="members">{(ctx) => <Members {...ctx} />}</Page>;
  const tokensPage = () => <Page current="tokens">{({ me }) => <Tokens me={me} />}</Page>;

  it("draws the same masthead and footer, with the current tab marked and no role or org switcher", async () => {
    vi.stubGlobal("fetch", fakeApi());
    await act(async () => root.render(sessionsPage()));
    expect(container.querySelector(".wordmark")!.getAttribute("href")).toBe("/app");
    expect(container.querySelector(".strapline")!.textContent).toBe("Session ledger · a Craftmill works");
    const tabs = [...container.querySelectorAll(".tab")];
    expect(tabs.map((a) => a.getAttribute("href"))).toEqual(["/app", "/app/members", "/app/tokens"]);
    expect(tabs.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null]);
    expect(container.querySelector(".who")!.textContent).toBe("alpha · Ada");
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector(".nav-button")!.textContent).toBe("Sign out");
    expect(container.querySelector(".footer")!.textContent).toBe("Sesh · Craftmill · Plumbline LLC, Maine");
  });

  it("signs out from the header on every signed-in page, and only there", async () => {
    vi.stubGlobal("fetch", fakeApi());
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    await act(async () => root.render(membersPage()));
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

  it("draws the landing page in the same chrome, pointing at login when signed out", async () => {
    localStorage.clear();
    await act(async () => root.render(<Landing />));
    expect(container.querySelector(".wordmark")).not.toBeNull();
    expect(container.querySelector("h1")!.textContent).toBe("Session insights for Claude Code teams");
    expect(container.querySelector("a.button")!.getAttribute("href")).toBe("/login");
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

  it("puts members and the org forms on the Members tab, once per org after each switch", async () => {
    vi.stubGlobal("fetch", fakeApi());
    await act(async () => root.render(membersPage()));
    const eyebrow = () => container.querySelector(".eyebrow")!.textContent;
    expect(container.querySelector("h1")!.textContent).toBe("Members");
    expect(eyebrow()).toBe("alpha · You own this org");
    expect(text()).toContain("Who is in alpha, and who counts toward its team plan.");
    expect(container.querySelector(".tab[aria-current]")!.textContent).toBe("Members");
    expect(text()).toContain("Ada");
    expect(text()).not.toContain("token of alpha");

    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("you");
    expect(rows[1]!.textContent).not.toContain("you");
    const boxes = [...container.querySelectorAll<HTMLInputElement>("tbody input[type=checkbox]")];
    expect(boxes.map((b) => [b.checked, b.disabled, b.getAttribute("aria-label")])).toEqual([
      [true, false, "Ada counts toward the team"],
      [false, true, "Sam does not count toward the team"],
    ]);
    expect(text()).toContain("You can change only your own.");
    expect(text()).toContain("Invite by email");

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
    expect(eyebrow()).toBe("beta · Member");
    expect(container.querySelectorAll(".tab[aria-current]")).toHaveLength(1);
    expect(container.textContent).not.toContain("Send invite"); // beta: a member, not an owner
    expect(consoleError).not.toHaveBeenCalled(); // no duplicate-key warnings
  });

  it("saves your own Counts box at once and says so", async () => {
    const fetchMock = fakeApi();
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(membersPage()));
    const own = container.querySelector<HTMLInputElement>("tbody input[type=checkbox]")!;
    await act(async () => own.click());
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/membership"))!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ counts_toward_team: false });
    expect(container.querySelector(".notice")!.textContent).toContain("You're an observer in alpha.");
  });

  it("puts the tokens and the env snippet on the Tokens tab, with the observer state", async () => {
    vi.stubGlobal("fetch", fakeApi());
    await act(async () => root.render(tokensPage()));
    expect(container.querySelector("h1")!.textContent).toBe("Tokens");
    expect(container.querySelector(".eyebrow")!.textContent).toBe("alpha · Ingest");
    expect(text()).toContain("Your tokens let Claude Code send alpha its session events.");
    expect(container.querySelector(".tab[aria-current]")!.textContent).toBe("Tokens");
    expect(text()).toContain("token of alpha");
    expect(text()).toContain("<your token>");
    expect(text()).not.toContain("Send invite");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("shows only the observer message on Tokens when the user does not count toward the team", async () => {
    vi.stubGlobal("fetch", fakeApi({ observer: true }));
    await act(async () => root.render(tokensPage()));
    expect(text()).toContain("You're an observer here, so you can't make tokens or send data.");
    expect(text()).not.toContain("Create token");
    expect(text()).not.toContain("token of alpha");
    expect(text()).toContain("Plan usage comes from the Claude Code status line");
  });

  it("routes /app/members and /app/tokens to their tabs, and sends /app/settings to Members", async () => {
    vi.stubGlobal("fetch", fakeApi());
    const replace = vi.fn();
    vi.stubGlobal("location", { replace });
    for (const [path, tab] of [
      ["/app/members", "Members"],
      ["/app/tokens", "Tokens"],
    ] as const) {
      await act(async () => root.render(page(path)));
      expect(container.querySelector(".tab[aria-current]")!.textContent).toBe(tab);
      expect(container.querySelector("h1")!.textContent).toBe(tab);
    }
    expect(replace).not.toHaveBeenCalled();
    await act(async () => root.render(page("/app/settings")));
    expect(replace).toHaveBeenCalledWith("/app/members");
  });
});
