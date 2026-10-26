import { createRoot } from "react-dom/client";
import { page } from "./routes.js";
import "./styles.css";

// One bundle for every page. The server sends the same HTML shell for each route (src/ui.ts) and links between pages
// are plain full-page loads, so picking the page from the path is all the routing there is.
createRoot(document.getElementById("root")!).render(page(location.pathname));
