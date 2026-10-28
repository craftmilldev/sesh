import { AllSessions } from "./all-sessions.js";
import { Members } from "./members.js";
import { Landing } from "./landing.js";
import { Home } from "./home.js";
import { Insights } from "./insights.js";
import { Page } from "./layout.js";
import { InvitePage } from "./invite.js";
import { Login } from "./login.js";
import { SessionDetail } from "./session-detail.js";
import { Tokens } from "./tokens.js";

/** The page for a path. One bundle serves every route (see main.tsx). */
export function page(path: string) {
  if (path === "/") return <Landing />;
  if (path === "/login") return <Login />;
  const invite = /^\/invite\/([^/]+)$/.exec(path);
  if (invite) return <InvitePage token={decodeURIComponent(invite[1]!)} />;
  const detail = /^\/app\/sessions\/([^/]+)$/.exec(path);
  if (detail) return <Page current="sessions">{() => <SessionDetail id={decodeURIComponent(detail[1]!)} />}</Page>;
  if (path === "/app/settings") {
    location.replace("/app/members"); // old links keep working
    return null;
  }
  if (path === "/app/members") return <Page current="members">{(ctx) => <Members {...ctx} />}</Page>;
  if (path === "/app/tokens") return <Page current="tokens">{({ me }) => <Tokens me={me} />}</Page>;
  if (path === "/app/insights") return <Page current="insights">{() => <Insights />}</Page>;
  if (path === "/app/sessions") return <Page current="sessions">{() => <AllSessions />}</Page>;
  return <Page current="sessions">{({ me }) => <Home orgName={me.org.name} />}</Page>;
}
