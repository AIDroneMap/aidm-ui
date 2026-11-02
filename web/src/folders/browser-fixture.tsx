import { createRoot } from "react-dom/client";
import { DetailsSection } from "../sections/details/DetailsSection.tsx";
import { PhotosSection } from "../sections/photos/PhotosSection.tsx";
import { SectionFixture } from "../shell/section-fixture.tsx";

// Details sits above Photos on this test page, so the test sees that a project read after an upload or import keeps the unsaved name and notes.
createRoot(document.getElementById("root")!).render(<SectionFixture sections={{ photos: (project, refresh) => <>
  <DetailsSection project={project} onChange={refresh} onAuthRequired={() => {}} />
  <PhotosSection project={project} onChange={refresh} onAuthRequired={() => {}} />
</> }} />);
