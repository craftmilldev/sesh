import { useEffect, useState } from "react";
import { Chrome } from "./layout.js";
import { api, ApiError, getToken, rememberNext, saveOrg, takeNext } from "./session.js";

// An invite link. Signed out, it sends the visitor to log in and then back here; signed in, it asks to join.
export function InvitePage({ token }: { token: string }) {
  const [org, setOrg] = useState<{ name: string }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    // Remembered even when a token is stored: it may be stale, and then the API call below sends the visitor to log in.
    rememberNext(`/invite/${token}`);
    if (!getToken()) {
      location.replace("/login");
      return;
    }
    api<{ org: { name: string } }>(`/invites/${encodeURIComponent(token)}`).then(
      (r) => setOrg(r.org),
      (err) => setError(err instanceof ApiError ? err.message : "Could not reach the server."),
    );
  }, [token]);

  async function join() {
    try {
      const r = await api<{ org: { id: string } }>(`/invites/${encodeURIComponent(token)}`, { body: {} });
      saveOrg(r.org.id);
      takeNext(); // the invite is spent, so don't return to it after a later sign-in
      location.replace("/app");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    }
  }

  if (error)
    return (
      <Chrome>
        <div className="signin">
          <h1>This invite doesn't work</h1>
          <p>{error} Ask an owner for a new one.</p>
          <p>
            <a href="/app">Back to sesh</a>
          </p>
        </div>
      </Chrome>
    );
  if (!org) return <Chrome />;
  return (
    <Chrome>
      <div className="signin">
        <p className="eyebrow">Sesh · Craftmill</p>
        <h1>Join {org.name}</h1>
        <p>
          <button type="button" className="primary" onClick={() => void join()}>
            Join this org
          </button>
        </p>
      </div>
    </Chrome>
  );
}
