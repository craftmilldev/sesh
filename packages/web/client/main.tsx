import { createRoot } from "react-dom/client";
import { AllSessions } from "./all-sessions.js";
import { Members } from "./members.js";
import { Landing } from "./landing.js";
import { Home } from "./home.js";
import { Page } from "./layout.js";
import { InvitePage } from "./invite.js";
import { Login } from "./login.js";
import { SessionDetail } from "./session-detail.js";
import { Tokens } from "./tokens.js";
import "./styles.css";

// One bundle for every page. The server sends the same HTML shell for each route (src/ui.ts) and links between pages
// are plain full-page loads, so picking the page from the path is all the routing there is.
function page(path: string) {
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
  if (path === "/app/sessions") return <Page current="sessions">{() => <AllSessions />}</Page>;
  return <Page current="sessions">{({ me }) => <Home orgName={me.org.name} />}</Page>;
}

createRoot(document.getElementById("root")!).render(page(location.pathname));
