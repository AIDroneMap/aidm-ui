import { createRoot } from "react-dom/client";
import { ProjectPage } from "../pages/ProjectPage.tsx";

declare global {
  interface Window { holdLinkRead: boolean; linkReadHeld: boolean; releaseLinkRead?: () => void }
}
const originalFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await originalFetch(input, init);
  if (typeof input === "string" && input.endsWith("/link") && init?.method === "GET" && window.holdLinkRead) {
    window.holdLinkRead = false;
    window.linkReadHeld = true;
    await new Promise<void>(resolve => { window.releaseLinkRead = resolve; });
  }
  return response;
}) as typeof window.fetch;

createRoot(document.getElementById("root")!).render(<ProjectPage onAuthRequired={() => {}} />);
