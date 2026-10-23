import { Chrome } from "./layout.js";
import { getToken } from "./session.js";

/** The public front page at the site root: what sesh is, and the way in. */
export function Landing() {
  return (
    <Chrome>
      <div className="signin">
        <p className="eyebrow">Sesh · Craftmill</p>
        <h1>Session insights for Claude Code teams</h1>
        <p>It shows the shape of the work, never who did it.</p>
        <p>
          <a className="button primary" href={getToken() ? "/app" : "/login"}>
            {getToken() ? "Open sesh" : "Sign in"}
          </a>
        </p>
      </div>
    </Chrome>
  );
}
