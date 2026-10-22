// Talks to the JSON API on the same origin. The session token, the active org and the page to return to after signing
// in are kept in localStorage, not cookies; the token goes in the Authorization header, so nothing is sent unless this
// code sends it. localStorage is readable by any script on the page, which is why the server's CSP allows only our bundle.

const SESSION_KEY = "sesh_session";
const ORG_KEY = "sesh_org";
const NEXT_KEY = "sesh_next";
const INVITE_PATH_RE = /^\/invite\/[A-Za-z0-9_-]{1,100}$/;

export const getToken = () => localStorage.getItem(SESSION_KEY);
export const saveToken = (token: string) => localStorage.setItem(SESSION_KEY, token);
export const saveOrg = (id: string) => localStorage.setItem(ORG_KEY, id);
export const rememberNext = (path: string) => localStorage.setItem(NEXT_KEY, path);

/** Forgets the session and the active org. */
export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(ORG_KEY);
}

/** Where to go after signing in: the invite link that sent a signed-out visitor here, else the app. Used once. */
export function takeNext() {
  const next = localStorage.getItem(NEXT_KEY);
  localStorage.removeItem(NEXT_KEY);
  return next && INVITE_PATH_RE.test(next) ? next : "/app";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the API: a POST when there is a body, else a GET. A 401 on a signed-in call drops the session and goes to the login page. */
export async function api<T>(path: string, opts: { body?: unknown; auth?: boolean } = {}): Promise<T> {
  const auth = opts.auth ?? true;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (auth) {
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const org = localStorage.getItem(ORG_KEY);
    if (org) headers["x-sesh-org"] = org;
  }
  const res = await fetch(`/api${path}`, {
    method: opts.body === undefined ? "GET" : "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }).catch(() => {
    throw new ApiError(0, "network", "Could not reach the server.");
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (res.status === 401 && auth) {
    clearSession();
    location.replace("/login");
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "Something went wrong.");
  return data as T;
}
