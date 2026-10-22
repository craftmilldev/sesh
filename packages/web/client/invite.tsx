import { useEffect, useState } from "react";
import { api, ApiError, getToken, rememberNext, saveOrg } from "./session.js";

// An invite link. Signed out, it sends the visitor to log in and then back here; signed in, it asks to join.
export function InvitePage({ token }: { token: string }) {
  const [org, setOrg] = useState<{ name: string }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!getToken()) {
      rememberNext(`/invite/${token}`);
      location.replace("/login");
      return;
    }
    api<{ org: { name: string } }>(`/invites/${encodeURIComponent(token)}`).then(
      (r) => setOrg(r.org),
      (err) => setError(err instanceof ApiError ? err.message : "Something went wrong."),
    );
  }, [token]);

  async function join() {
    try {
      const r = await api<{ org: { id: string } }>(`/invites/${encodeURIComponent(token)}`, { body: {} });
      saveOrg(r.org.id);
      location.replace("/app");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  }

  if (error)
    return (
      <>
        <h1>This invite doesn't work</h1>
        <p>{error} Ask an owner for a new one.</p>
        <p>
          <a href="/app">Back to sesh</a>
        </p>
      </>
    );
  if (!org) return null;
  return (
    <>
      <h1>Join {org.name}</h1>
      <button type="button" onClick={() => void join()}>
        Join this org
      </button>
    </>
  );
}
