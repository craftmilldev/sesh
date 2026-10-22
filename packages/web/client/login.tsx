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
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  }

  return sent ? (
    <form onSubmit={(e) => void submit(e)}>
      <h1>Check your email</h1>
      <p>
        We sent a login code to {sent.email}. It expires in {sent.ttl_minutes} minutes.
      </p>
      {error && <p className="error">{error}</p>}
      <p>
        <label>
          Code{" "}
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
        <button type="submit">Sign in</button>
      </p>
    </form>
  ) : (
    <form onSubmit={(e) => void submit(e)}>
      <h1>Sign in to sesh</h1>
      {error && <p className="error">{error}</p>}
      <p>
        <label>
          Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
      </p>
      <p>
        <button type="submit">Send me a code</button>
      </p>
    </form>
  );
}
