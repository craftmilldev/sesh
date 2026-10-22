// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/app.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const orgs = [
  { id: "o1", name: "alpha", role: "owner" },
  { id: "o2", name: "beta", role: "member" },
];

/** A fake API where /me reports whichever org the last switch chose. */
function fakeApi() {
  let active = orgs[0]!;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, "").split("?")[0];
    if (path === "/orgs/switch")
      active = orgs.find((o) => o.id === (JSON.parse(init?.body as string) as { org: string }).org)!;
    const body =
      path === "/me"
        ? { user: { name: "Ada" }, org: active, orgs, ingest_endpoint: "https://sesh.test" }
        : path === "/sessions"
          ? { page: 1, page_size: 20, total: 0, sessions: [] }
          : path === "/limits"
            ? { limits: [] }
            : path === "/tokens"
              ? { tokens: [{ id: `t-${active.id}`, name: `token of ${active.name}` }] }
              : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("App org switching", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem("sesh_session", "tok");
    vi.stubGlobal("fetch", fakeApi());
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

  const headings = () => [...container.querySelectorAll("h2")].map((h) => h.textContent);
  async function switchTo(id: string) {
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Switch")!;
    await act(async () => button.click());
  }

  it("shows one Sessions block and one Tokens block for the active org after each switch", async () => {
    await act(async () => root.render(<App />));
    expect(headings()).toEqual(["Sessions in alpha", "Ingest tokens for alpha"]);

    await switchTo("o2");
    expect(headings()).toEqual(["Sessions in beta", "Ingest tokens for beta"]);
    expect(container.textContent).toContain("token of beta");
    expect(container.textContent).not.toContain("token of alpha");

    await switchTo("o2"); // the same org again
    expect(headings()).toEqual(["Sessions in beta", "Ingest tokens for beta"]);

    await switchTo("o1");
    expect(headings()).toEqual(["Sessions in alpha", "Ingest tokens for alpha"]);
    expect(consoleError).not.toHaveBeenCalled(); // no duplicate-key warnings
  });
});
