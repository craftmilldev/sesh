import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, getToken } from "./session.js";

export interface Org {
  id: string;
  name: string;
  role: "owner" | "member";
}
export interface Me {
  user: { name: string };
  org: Org;
  orgs: Org[];
  ingest_endpoint: string;
}

export const message = (err: unknown) => (err instanceof ApiError ? err.message : "Could not reach the server.");

/**
 * Every signed-in page: loads who is signed in, draws the masthead and footer, and hands the page `me` and a way to
 * reload it. The page is keyed by org, so switching org remounts it and nothing of the old org lingers.
 */
export function Page({
  current,
  children,
}: {
  current: "sessions" | "settings";
  children: (ctx: { me: Me; reload: () => Promise<void> }) => ReactNode;
}) {
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => setMe(await api<Me>("/me")), []);
  useEffect(() => {
    if (!getToken()) return location.replace("/login");
    reload().catch((err) => setError(message(err)));
  }, [reload]);

  if (!me) return error ? <p className="error page">{error}</p> : null;
  return (
    <>
      <div className="page">
        <header className="masthead">
          <div className="masthead-row">
            <span className="masthead-rule" />
            <a className="wordmark" href="/app">
              SESH
            </a>
            <span className="masthead-rule" />
          </div>
          <p className="strapline">Session ledger · a Craftmill works</p>
        </header>
        <nav className="nav">
          <a className="tab" href="/app" aria-current={current === "sessions" ? "page" : undefined}>
            Sessions
          </a>
          <a className="tab" href="/app/settings" aria-current={current === "settings" ? "page" : undefined}>
            Org &amp; tokens
          </a>
          <span className="nav-spacer" />
          <span className="who">
            {me.org.name} · {me.user.name}
          </span>
        </nav>
        <main>
          <Fragment key={me.org.id}>{children({ me, reload })}</Fragment>
        </main>
      </div>
      <footer className="footer">
        <div className="footer-inner">Sesh · Craftmill · Plumbline LLC, Maine</div>
      </footer>
    </>
  );
}
