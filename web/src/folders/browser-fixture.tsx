import { createRoot } from "react-dom/client";
import { ProjectPage } from "../pages/ProjectPage.tsx";
createRoot(document.getElementById("root")!).render(<ProjectPage onAuthRequired={() => {}} />);
