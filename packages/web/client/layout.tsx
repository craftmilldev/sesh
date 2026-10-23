import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, clearSession, getToken } from "./session.js";

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

/** Ends the session: tells the server (best effort, it only records the sign-out) and forgets the token. */
function signOut() {
  void api("/logout", { body: {} }).catch(() => undefined);
  clearSession();
  location.replace("/");
}

/**
 * The masthead, nav and footer around every page, signed in or not. Sign in or Sign out is always in the nav; the
 * tabs and who is signed in show only once `me` is known.
 */
export function Chrome({
  current,
  me,
  children,
}: {
  current?: "sessions" | "settings" | "login";
  me?: Me;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="page">
        <header className="masthead">
          <div className="masthead-row">
            <span className="masthead-rule" />
            <a className="wordmark" href={me ? "/app" : "/"}>
              SESH
            </a>
            <span className="masthead-rule" />
          </div>
          <p className="strapline">Session ledger · a Craftmill works</p>
        </header>
        <nav className="nav">
          {me && (
            <>
              <a className="tab" href="/app" aria-current={current === "sessions" ? "page" : undefined}>
                Sessions
              </a>
              <a className="tab" href="/app/settings" aria-current={current === "settings" ? "page" : undefined}>
                Org &amp; tokens
              </a>
            </>
          )}
          <span className="nav-spacer" />
          {me && (
            <span className="who">
              {me.org.name} · {me.user.name}
            </span>
          )}
          {getToken() ? (
            <button type="button" className="nav-button" onClick={signOut}>
              Sign out
            </button>
          ) : (
            <a className="tab" href="/login" aria-current={current === "login" ? "page" : undefined}>
              Sign in
            </a>
          )}
        </nav>
        <main>{children}</main>
      </div>
      <footer className="footer">
        <div className="footer-inner">Sesh · Craftmill · Plumbline LLC, Maine</div>
      </footer>
    </>
  );
}

/**
 * Every signed-in page: loads who is signed in, draws the chrome, and hands the page `me` and a way to reload it. The
 * page is keyed by org, so switching org remounts it and nothing of the old org lingers.
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

  if (!me) return <Chrome current={current}>{error && <p className="error">{error}</p>}</Chrome>;
  return (
    <Chrome current={current} me={me}>
      <Fragment key={me.org.id}>{children({ me, reload })}</Fragment>
    </Chrome>
  );
}
