import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { InvitePage } from "./invite.js";
import { Login } from "./login.js";
import "./styles.css";

// One bundle for every page. The server sends the same HTML shell for each route (src/ui.ts) and links between pages
// are plain full-page loads, so picking the page from the path is all the routing there is.
function page(path: string) {
  if (path === "/login") return <Login />;
  const invite = /^\/invite\/([^/]+)$/.exec(path);
  if (invite) return <InvitePage token={decodeURIComponent(invite[1]!)} />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(page(location.pathname));
