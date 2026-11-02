import { createRoot } from "react-dom/client";
import { DetailsSection } from "../sections/details/DetailsSection.tsx";
import { PhotosSection } from "../sections/photos/PhotosSection.tsx";
import { SettingsSection } from "../sections/settings/SettingsSection.tsx";
import { SectionFixture } from "../shell/section-fixture.tsx";

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

// The three sections share one test page here, as the one project page had them, so the test sees that a link
// change and its project read keep the unsaved name and notes and leave the run review working.
createRoot(document.getElementById("root")!).render(<SectionFixture sections={{ photos: (project, refresh) => <>
  <DetailsSection project={project} onChange={refresh} onAuthRequired={() => {}} />
  <PhotosSection project={project} onChange={refresh} onAuthRequired={() => {}} />
  <SettingsSection project={project} onAuthRequired={() => {}} />
</> }} />);
