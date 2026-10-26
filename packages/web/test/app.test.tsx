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

const baseOrgs = [
  { id: "o1", name: "alpha", role: "owner", counts_toward_team: true },
  { id: "o2", name: "beta", role: "member", counts_toward_team: true },
];

let orgs = [...baseOrgs];

/** A fake API where /me reports whichever org the last switch chose. */
function fakeApi(opts: { sessions?: number; observer?: boolean } = {}) {
  let active = opts.observer ? { ...orgs[0]!, counts_toward_team: false } : orgs[0]!;
  const sessions = opts.sessions ?? 3;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, "").split("?")[0];
    if (path === "/orgs") {
      orgs.push({
        id: "o3",
        name: (JSON.parse(init?.body as string) as { name: string }).name,
        role: "owner",
        counts_toward_team: true,
      });
      active = orgs[2]!;
      return new Response(JSON.stringify({ org: active }), { status: 201 });
    }
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
    orgs = baseOrgs.map((o) => ({ ...o }));
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

  it("draws the same masthead and footer, with the current tab marked and the org switcher before the name", async () => {
    vi.stubGlobal("fetch", fakeApi());
    await act(async () => root.render(sessionsPage()));
    expect(container.querySelector(".wordmark")!.getAttribute("href")).toBe("/app");
    expect(container.querySelector(".strapline")!.textContent).toBe("Session ledger · a Craftmill works");
    const tabs = [...container.querySelectorAll(".tab")];
    expect(tabs.map((a) => a.getAttribute("href"))).toEqual(["/app", "/app/members", "/app/tokens"]);
    expect(tabs.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null]);
    expect(container.querySelector(".who")!.textContent).toBe("Ada");
    expect(container.querySelector(".org-switch-button")!.textContent).toBe("alpha");
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

  it("puts members on the Members tab, once per org after each switch", async () => {
    vi.stubGlobal("fetch", fakeApi());
    await act(async () => root.render(membersPage()));
    const eyebrow = () => container.querySelector(".eyebrow")!.textContent;
    expect(container.querySelector("h1")!.textContent).toBe("Members");
    expect(eyebrow()).toBe("alpha · You own this org");
    expect(text()).toContain("Who is in alpha, and who counts toward its team plan.");
    expect(container.querySelector(".tab[aria-current]")!.textContent).toBe("Members");
    expect(text()).toContain("Ada");
    expect(text()).not.toContain("token of alpha");

    const switchTo = async (name: string) => {
      await act(async () => container.querySelector<HTMLElement>(".org-switch-button")!.click());
      const item = [...container.querySelectorAll<HTMLElement>("[role=menuitem]")].find((i) =>
        i.textContent?.includes(name),
      )!;
      await act(async () => item.click());
    };
    await switchTo("beta");
    expect(eyebrow()).toBe("beta · Member");
    expect(container.querySelectorAll(".tab[aria-current]")).toHaveLength(1);
    expect(container.textContent).not.toContain("Send invite"); // beta: a member, not an owner
    expect(consoleError).not.toHaveBeenCalled(); // no duplicate-key warnings
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

  describe("org switcher", () => {
    const button = () => container.querySelector<HTMLButtonElement>(".org-switch-button")!;
    const items = () => [...container.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const key = (el: Element, k: string) =>
      act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

    async function open() {
      vi.stubGlobal("fetch", fakeApi());
      await act(async () => root.render(sessionsPage()));
      await act(async () => button().click());
    }

    it("lists every org with its role, marks the current one and focuses it", async () => {
      await open();
      expect(button().getAttribute("aria-label")).toBe("Org: alpha. Switch org");
      expect(button().getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector("[role=menu]")).not.toBeNull();
      expect(items().map((i) => i.textContent)).toEqual(["✓alphaowner", "betamember"]);
      expect(items().map((i) => i.getAttribute("aria-current"))).toEqual(["page", null]);
      expect(document.activeElement).toBe(items()[0]);
    });

    it("shows the switcher with a single org", async () => {
      vi.stubGlobal("fetch", fakeApi());
      orgs = [orgs[0]!];
      await act(async () => root.render(sessionsPage()));
      expect(button().textContent).toBe("alpha");
    });

    it("moves with the arrow, Home and End keys, and closes on Escape with focus back on the button", async () => {
      await open();
      await key(items()[0]!, "ArrowDown");
      expect(document.activeElement).toBe(items()[1]);
      await key(items()[1]!, "Home");
      expect(document.activeElement).toBe(items()[0]);
      await key(items()[0]!, "End");
      expect(document.activeElement).toBe(items()[1]);
      await key(items()[1]!, "ArrowDown"); // past the last org: the New org input
      expect(document.activeElement).toBe(container.querySelector("input"));
      await key(container.querySelector("input")!, "ArrowUp");
      expect(document.activeElement).toBe(items()[1]);
      await key(items()[1]!, "Escape");
      expect(container.querySelector("[role=menu]")).toBeNull();
      expect(document.activeElement).toBe(button());
    });

    it("closes on Tab and on a mousedown outside", async () => {
      await open();
      await key(items()[0]!, "Tab");
      expect(container.querySelector("[role=menu]")).toBeNull();
      await act(async () => button().click());
      await act(async () => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      expect(container.querySelector("[role=menu]")).toBeNull();
    });

    it("switches org from the menu, remembers it and reloads the page", async () => {
      await open();
      await act(async () => items()[1]!.click());
      expect(localStorage.getItem("sesh_org")).toBe("o2");
      expect(button().textContent).toBe("beta");
      expect(container.querySelector("[role=menu]")).toBeNull();
    });

    it("creates an org from the menu and switches to it", async () => {
      await open();
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "gamma");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(input.maxLength).toBe(80);
      await act(async () => container.querySelector<HTMLButtonElement>(".org-switch-new button")!.click());
      expect(localStorage.getItem("sesh_org")).toBe("o3");
      expect(button().textContent).toBe("gamma");
    });

    it("has no switch or New org form on the Members page any more", async () => {
      vi.stubGlobal("fetch", fakeApi());
      await act(async () => root.render(membersPage()));
      expect(container.querySelector("main select")).toBeNull();
      expect(container.querySelector("main")!.textContent).not.toContain("New org");
    });
  });
});
