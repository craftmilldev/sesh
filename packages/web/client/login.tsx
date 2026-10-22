import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, getToken, saveToken, takeNext } from "./session.js";

export function Login() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ email: string; ttl_minutes: number }>();
  const [error, setError] = useState<string>();

  // A stored token that still works skips the form (a stale one is dropped by the API helper).
  useEffect(() => {
    if (getToken())
      void api("/me").then(
        () => location.replace(takeNext()),
        () => undefined,
      );
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      if (!sent) {
        setSent(await api("/login", { body: { email }, auth: false }));
      } else {
        const r = await api<{ token: string }>("/login/verify", { body: { email: sent.email, code }, auth: false });
        saveToken(r.token);
        location.replace(takeNext());
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    }
  }

  return sent ? (
    <form className="page signin" onSubmit={(e) => void submit(e)}>
      <p className="eyebrow">Sesh · Craftmill</p>
      <h1>Check your email</h1>
      <p>
        We sent a login code to {sent.email}. It expires in {sent.ttl_minutes} minutes.
      </p>
      {error && <p className="error">{error}</p>}
      <p>
        <label>
          Code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
            autoComplete="one-time-code"
          />
        </label>
      </p>
      <p>
        <button type="submit" className="primary">
          Sign in
        </button>
      </p>
    </form>
  ) : (
    <form className="page signin" onSubmit={(e) => void submit(e)}>
      <p className="eyebrow">Sesh · Craftmill</p>
      <h1>Sign in to sesh</h1>
      {error && <p className="error">{error}</p>}
      <p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
      </p>
      <p>
        <button type="submit" className="primary">
          Send me a code
        </button>
      </p>
    </form>
  );
}
