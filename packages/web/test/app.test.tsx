// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../client/home.js";
import { BarChart } from "../client/chart.js";
import { Insights } from "../client/insights.js";
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

/** The activity endpoint's answer: `days` UTC days ending 2026-10-27, `n` tool calls on the nth day, 2 prompts a day except the first (none, so no ratio). */
function insights(days: number, sessions: number) {
  const rows = Array.from({ length: days }, (_, i) => ({
    day: new Date(Date.UTC(2026, 9, 27 - (days - 1 - i))).toISOString().slice(0, 10),
    tool_calls: i + 1,
    prompts: i === 0 ? 0 : 2,
    active_sessions: 1,
    tool_calls_per_prompt: i === 0 ? null : (i + 1) / 2,
  }));
  const last = rows.at(-1)!;
  const today = {
    tool_calls: last.tool_calls,
    prompts: last.prompts,
    active_sessions: last.active_sessions,
    tool_calls_per_prompt: last.tool_calls_per_prompt,
  };
  const by_dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((dow, i) => ({
    dow,
    tool_calls: i + 1,
    prompts: 2,
    active_sessions: 1,
    tool_calls_per_prompt: (i + 1) / 2,
  }));
  return { days: rows, by_dow, today, org_sessions: sessions };
}

/** The pace endpoint's answer: no pace on the first day, then 80, 90, 100... */
function paceDays(days: number) {
  return {
    days: Array.from({ length: days }, (_, i) => ({
      day: new Date(Date.UTC(2026, 9, 27 - (days - 1 - i))).toISOString().slice(0, 10),
      pace: i === 0 ? null : 70 + i * 10,
    })),
  };
}

/** The limit-hits endpoint's answer: one member on the first day, two on the last. */
function limitHitDays(days: number) {
  return {
    days: Array.from({ length: days }, (_, i) => ({
      day: new Date(Date.UTC(2026, 9, 27 - (days - 1 - i))).toISOString().slice(0, 10),
      members: i === days - 1 ? 2 : i === 0 ? 1 : 0,
    })),
  };
}

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
        : path === "/insights/limit-hits"
          ? limitHitDays(Number(new URLSearchParams(url.split("?")[1]).get("days")))
          : path === "/insights/pace"
            ? paceDays(Number(new URLSearchParams(url.split("?")[1]).get("days")))
            : path === "/insights/activity"
              ? insights(Number(new URLSearchParams(url.split("?")[1]).get("days")), sessions)
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
                    : path === "/tokens" && init?.method === "POST"
                      ? { token: "sesh_fresh" }
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
    expect(tabs.map((a) => a.getAttribute("href"))).toEqual(["/app", "/app/insights", "/app/members", "/app/tokens"]);
    expect(tabs.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null, null]);
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
    const fetchMock = fakeApi();
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(sessionsPage()));
    // The server decides what "today" is (the UTC day); the page sends no time.
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/today")).toBe(true);
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

  const open = async () => {
    await act(async () => root.render(<Page current="insights">{() => <Insights />}</Page>));
  };
  const chips = () => [...container.querySelectorAll<HTMLButtonElement>(".chip")];
  const on = () =>
    chips()
      .filter((c) => c.getAttribute("aria-pressed") === "true")
      .map((c) => c.textContent);
  const lines = () =>
    [...container.querySelectorAll<SVGGElement>(".chart-series:not([data-series=pace])")].map((g) => g.dataset.series);

  it("draws today's numbers and one line chart, and refetches when the range changes", async () => {
    const fetchMock = fakeApi();
    vi.stubGlobal("fetch", fetchMock);
    history.replaceState(null, "", "/app/insights");
    await open();
    const urls = () => fetchMock.mock.calls.map(([u]) => u).filter((u) => String(u).includes("insights/activity"));
    expect(urls()).toEqual(["/api/insights/activity?days=14"]);
    expect([...container.querySelectorAll(".figure .num")].map((n) => n.textContent)).toEqual(["2", "14", "1", "7"]);
    expect(container.querySelectorAll("svg.chart")).toHaveLength(3); // activity, plan pace and limit hits
    expect(lines()).toEqual(["prompts", "tools", "sessions"]);
    expect(container.querySelectorAll('[data-series="tools"] .chart-dot')).toHaveLength(14);
    expect(container.querySelector(".tab[aria-current]")!.textContent).toBe("Insights");
    const button = [...container.querySelectorAll<HTMLButtonElement>(".range-button")].find(
      (b) => b.textContent === "28 days",
    )!;
    await act(async () => button.click());
    expect(urls()).toEqual(["/api/insights/activity?days=14", "/api/insights/activity?days=28"]);
    expect(location.search).toBe("?days=28");
    expect(container.querySelectorAll('[data-series="tools"] .chart-dot')).toHaveLength(28);
  });

  it("turns metrics on and off, keeps them in the URL, and never turns the last one off", async () => {
    vi.stubGlobal("fetch", fakeApi());
    history.replaceState(null, "", "/app/insights");
    await open();
    expect(on()).toEqual(["Prompts", "Tool calls", "Active sessions"]);
    const chip = (name: string) => chips().find((c) => c.textContent === name)!;
    await act(async () => chip("Active sessions").click());
    expect(lines()).toEqual(["prompts", "tools"]);
    expect(location.search).toBe("?metrics=prompts,tools");
    await act(async () => chip("Tool calls").click());
    expect(location.search).toBe("?metrics=prompts");
    expect(chip("Prompts").getAttribute("aria-disabled")).toBe("true");
    await act(async () => chip("Prompts").click());
    expect(lines()).toEqual(["prompts"]);
    expect(location.search).toBe("?metrics=prompts");
    // Back to the defaults leaves the URL clean; the range and the metrics are kept together.
    await act(async () => chip("Tool calls").click());
    await act(async () => chip("Active sessions").click());
    expect(location.search).toBe("");
    await act(async () => chip("Active sessions").click());
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>(".range-button")]
        .find((b) => b.textContent === "7 days")!
        .click(),
    );
    expect(location.search).toBe("?days=7&metrics=prompts,tools");
    history.replaceState(null, "", "/");
  });

  it("starts on the metrics in the URL, in chart order, and falls back to the default for junk", async () => {
    vi.stubGlobal("fetch", fakeApi());
    history.replaceState(null, "", "/app/insights?metrics=ratio,prompts");
    await open();
    expect(on()).toEqual(["Prompts", "Tool calls per prompt"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    history.replaceState(null, "", "/app/insights?metrics=nope");
    await open();
    expect(on()).toEqual(["Prompts", "Tool calls", "Active sessions"]);
    history.replaceState(null, "", "/");
  });

  it("gives tool calls per prompt its own labeled axis and a gap on a day with no prompts", async () => {
    vi.stubGlobal("fetch", fakeApi());
    history.replaceState(null, "", "/app/insights?days=7&metrics=tools,ratio");
    await open();
    const axis = container.querySelector(".chart-right-axis")!;
    expect(axis.querySelector(".chart-axis-title")!.textContent).toBe("Tool calls per prompt");
    // 7 days: no ratio on the first, so six dots, and the line starts at the second day.
    expect(container.querySelectorAll('[data-series="ratio"] .chart-dot')).toHaveLength(6);
    expect(container.querySelectorAll('[data-series="tools"] .chart-dot')).toHaveLength(7);
    // Without the ratio, there is no right axis; with only the ratio, its ticks are the left axis.
    await act(async () =>
      chips()
        .find((c) => c.textContent === "Tool calls")!
        .click(),
    );
    expect(container.querySelector(".chart-right-axis")).toBeNull();
    expect([...container.querySelectorAll(".chart-grid + .chart-tick")].map((t) => t.textContent)).toContain("2");
    history.replaceState(null, "", "/");
  });

  it("labels every day and shows the date and every visible series on hover and focus", async () => {
    vi.stubGlobal("fetch", fakeApi());
    history.replaceState(null, "", "/app/insights?days=7&metrics=prompts,tools,ratio");
    await open();
    const chart = container.querySelector("svg.chart")!;
    const days = [...chart.querySelectorAll<SVGGElement>(".chart-point")];
    expect(days.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Wed Oct 21: Prompts: 0, Tool calls: 1, Tool calls per prompt: –",
      "Thu Oct 22: Prompts: 2, Tool calls: 2, Tool calls per prompt: 1",
      "Fri Oct 23: Prompts: 2, Tool calls: 3, Tool calls per prompt: 1.5",
      "Sat Oct 24: Prompts: 2, Tool calls: 4, Tool calls per prompt: 2",
      "Sun Oct 25: Prompts: 2, Tool calls: 5, Tool calls per prompt: 2.5",
      "Mon Oct 26: Prompts: 2, Tool calls: 6, Tool calls per prompt: 3",
      "Tue Oct 27: Prompts: 2, Tool calls: 7, Tool calls per prompt: 3.5",
    ]);
    const ticks = [...chart.querySelectorAll(".chart-tick.day")].map((t) => t.textContent);
    expect(ticks).toEqual(["W21Oct", "T22", "F23", "S24", "S25", "M26", "T27today"]);
    expect(container.querySelector(".chart-tip")).toBeNull();
    expect(chart.querySelector(".chart-guide")).toBeNull();

    await act(async () => days[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(container.querySelector(".chart-tip")!.textContent).toBe(
      "Thu Oct 22Prompts: 2Tool calls: 2Tool calls per prompt: 1",
    );
    expect(chart.querySelector(".chart-guide")).not.toBeNull();
    await act(async () => days[0]!.focus());
    expect(container.querySelector(".chart-tip")!.textContent).toBe(
      "Wed Oct 21Prompts: 0Tool calls: 1Tool calls per prompt: –",
    );
    await act(async () => days[0]!.blur());
    expect(container.querySelector(".chart-tip")).toBeNull();
    history.replaceState(null, "", "/");
  });

  it("thins the day ticks at 28 days but keeps today and the month start", async () => {
    vi.stubGlobal("fetch", fakeApi());
    history.replaceState(null, "", "/app/insights?days=28");
    await open();
    const ticks = [...container.querySelector("svg.chart")!.querySelectorAll(".chart-tick.day")].map(
      (t) => t.textContent,
    );
    expect(ticks).toHaveLength(15);
    expect(ticks.at(-1)).toBe("T27today");
    history.replaceState(null, "", "/");
  });

  it("keeps the month name on the 1st even when thinning would skip that day", async () => {
    // Ends Nov 2, so Nov 1 is one day back: an odd offset the every-other-day thinning would skip.
    const values = Array.from({ length: 28 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 10, 2 - (27 - i))).toISOString().slice(0, 10),
      value: i,
    }));
    await act(async () => root.render(<BarChart title="Prompts" values={values} />));
    const ticks = [...container.querySelector("svg.chart")!.querySelectorAll(".chart-tick.day")].map(
      (t) => t.textContent,
    );
    expect(ticks).toContain("S1Nov");
    expect(ticks.at(-1)).toBe("M2today");
  });

  it("switches the chart between the daily series and the weekday averages, keeping the choice in the URL", async () => {
    vi.stubGlobal("fetch", fakeApi());
    history.replaceState(null, "", "/app/insights");
    await open();
    const view = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[aria-label="View"] button')].find(
        (b) => b.textContent === name,
      )!;
    expect(view("By day").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll('[data-series="tools"] .chart-dot')).toHaveLength(14);
    await act(async () => view("By weekday").click());
    expect(location.search).toBe("?by=weekday");
    expect(view("By weekday").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll('[data-series="tools"] .chart-dot')).toHaveLength(7);
    expect(
      [...container.querySelector("svg.chart")!.querySelectorAll(".chart-tick.day")].map((t) => t.textContent),
    ).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(container.querySelector("svg.chart")!.querySelector(".chart-point.today")).toBeNull();
    expect(container.querySelector("svg.chart")!.querySelector(".chart-point")!.getAttribute("aria-label")).toBe(
      "Mon: Prompts: 2, Tool calls: 1, Active sessions: 1",
    );
    await act(async () => view("By day").click());
    expect(location.search).toBe("");
    expect(container.querySelectorAll('[data-series="tools"] .chart-dot')).toHaveLength(14);
    history.replaceState(null, "", "/app/insights?by=weekday");
    await act(async () => root.unmount());
    root = createRoot(container);
    await open();
    expect(container.querySelectorAll('[data-series="tools"] .chart-dot')).toHaveLength(7);
    history.replaceState(null, "", "/");
  });

  it("draws the plan pace as a line with a 100 = on pace reference, a gap for a day with none, and follows the range", async () => {
    const fetchMock = fakeApi();
    vi.stubGlobal("fetch", fetchMock);
    history.replaceState(null, "", "/app/insights?days=7");
    await open();
    const chart = () => container.querySelectorAll<SVGSVGElement>("svg.chart")[1]!;
    expect(chart().closest("figure")!.querySelector(".chart-title")!.textContent).toBe("Plan pace");
    expect(chart().querySelector(".chart-reference text")!.textContent).toBe("100 = on pace");
    expect(chart().querySelectorAll(".chart-reference line")).toHaveLength(1);
    expect(chart().querySelectorAll('[data-series="pace"] .chart-dot')).toHaveLength(6); // the first day is a gap
    expect(chart().querySelectorAll('[data-series="pace"] polyline')).toHaveLength(1);
    const points = [...chart().querySelectorAll(".chart-point")];
    expect(points[0]!.getAttribute("aria-label")).toBe("Wed Oct 21: Plan pace: –");
    expect(points[6]!.getAttribute("aria-label")).toBe("Tue Oct 27: Plan pace: 130");
    // The axis reaches past the reference line even when every day is under it.
    expect([...chart().querySelectorAll(".chart-grid + .chart-tick")].map((t) => t.textContent)).toContain("100");
    const button = [...container.querySelectorAll<HTMLButtonElement>(".range-button")].find(
      (b) => b.textContent === "28 days",
    )!;
    await act(async () => button.click());
    expect(fetchMock.mock.calls.map(([u]) => u).filter((u) => String(u).includes("insights/pace"))).toEqual([
      "/api/insights/pace?days=7",
      "/api/insights/pace?days=28",
    ]);
    expect(chart().querySelectorAll('[data-series="pace"] .chart-dot')).toHaveLength(27);
    history.replaceState(null, "", "/");
  });

  it("draws 5h limit hits as bars with today's number, and follows the range", async () => {
    const fetchMock = fakeApi();
    vi.stubGlobal("fetch", fetchMock);
    history.replaceState(null, "", "/app/insights?days=7");
    await open();
    const figure = () => container.querySelectorAll<HTMLElement>("figure.chart-figure")[2]!;
    expect(figure().querySelector(".chart-title")!.textContent).toBe("5h limit reached");
    expect(figure().querySelector(".chart-today")!.textContent).toBe("2 today");
    const bars = [...figure().querySelectorAll(".chart-point")];
    expect(bars).toHaveLength(7);
    expect(bars[0]!.getAttribute("aria-label")).toBe("Wed Oct 21: 5h limit reached: 1");
    expect(bars[3]!.getAttribute("aria-label")).toBe("Sat Oct 24: 5h limit reached: 0");
    expect(bars[6]!.getAttribute("aria-label")).toBe("Tue Oct 27: 5h limit reached: 2");
    const button = [...container.querySelectorAll<HTMLButtonElement>(".range-button")].find(
      (b) => b.textContent === "28 days",
    )!;
    await act(async () => button.click());
    expect(fetchMock.mock.calls.map(([u]) => u).filter((u) => String(u).includes("insights/limit-hits"))).toEqual([
      "/api/insights/limit-hits?days=7",
      "/api/insights/limit-hits?days=28",
    ]);
    expect(figure().querySelectorAll(".chart-point")).toHaveLength(28);
    history.replaceState(null, "", "/");
  });

  it("starts the insights page on the range in the URL", async () => {
    const fetchMock = fakeApi();
    vi.stubGlobal("fetch", fetchMock);
    history.replaceState(null, "", "/app/insights?days=7");
    await open();
    expect(container.querySelectorAll('svg.chart [data-series="prompts"] .chart-dot')).toHaveLength(7);
    history.replaceState(null, "", "/");
  });

  it("shows the connect hint on insights when the org has no sessions", async () => {
    vi.stubGlobal("fetch", fakeApi({ sessions: 0 }));
    await act(async () => root.render(<Page current="insights">{() => <Insights />}</Page>));
    expect(text()).toContain("Sessions appear here once Claude Code sends its first events.");
    expect(container.querySelector("svg.chart")).toBeNull();
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
    expect(container.querySelector("table.ledger th .sr-only")!.textContent).toBe("Actions");
    expect(container.querySelector("table.ledger button.ghost")!.textContent).toBe("Revoke");
    expect(container.querySelector(".panel")!.textContent).toContain("<your token>");
    expect(text()).not.toContain("Send invite");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("copies the fresh token, says so, resets on the next create, and reports a refused clipboard", async () => {
    vi.stubGlobal("fetch", fakeApi());
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await act(async () => root.render(tokensPage()));
    const type = async (value: string) => {
      const input = container.querySelector<HTMLInputElement>("form input")!;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.bind(input);
      await act(async () => {
        set(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
    };
    const copyButton = () => container.querySelector<HTMLButtonElement>(".fresh button.ghost")!;
    await type("laptop");
    expect(container.querySelector(".fresh code")!.textContent).toBe("sesh_fresh");
    expect(copyButton().textContent).toBe("Copy");
    await act(async () => copyButton().click());
    expect(writeText).toHaveBeenCalledWith("sesh_fresh");
    expect(copyButton().textContent).toBe("Copied");
    await type("desktop");
    expect(copyButton().textContent).toBe("Copy");
    await act(async () => copyButton().click());
    expect(container.querySelector(".notice.error")!.textContent).toContain("Couldn't copy");
  });

  it("shows only the observer message on Tokens when the user does not count toward the team", async () => {
    vi.stubGlobal("fetch", fakeApi({ observer: true }));
    await act(async () => root.render(tokensPage()));
    expect(text()).toContain(
      "You only look at alpha, so you have no tokens here. Tick Counts on Members to make some.",
    );
    expect(container.querySelector('a[href="/app/members"]:not(.tab)')!.textContent).toBe("Members");
    expect(container.querySelector("table.ledger")).toBeNull();
    expect(container.querySelector(".panel")).toBeNull();
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
